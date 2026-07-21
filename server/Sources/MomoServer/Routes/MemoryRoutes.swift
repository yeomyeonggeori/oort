import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct MemorySourceRefRequest: Decodable, Sendable {
    let messageId: UUID
    let channelId: UUID
}

struct CreateMemoryRequest: Decodable, Sendable {
    let scope: String
    let subjectMemberId: UUID?
    let agentMemberId: UUID?
    let channelId: UUID?
    let kind: String
    let body: String
    let confidence: Double
    let validAtMs: Int64?
    let sourceRefs: [MemorySourceRefRequest]
}

struct UpdateMemoryRequest: Decodable, Sendable {
    let body: String?
    let confidence: Double?
}

struct InvalidateMemoryRequest: Decodable, Sendable {
    let invalidatedByMemoryId: UUID?
}

struct PutMemoryPolicyRequest: Decodable, Sendable {
    let enabled: Bool
}

struct MemorySourceRefDTO: Codable, Sendable, Equatable {
    let messageId: String
    let channelId: String
}

struct MemoryItemDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let scope: String
    let subjectMemberId: String?
    let agentMemberId: String?
    let channelId: String?
    let kind: String
    let body: String
    let confidence: Double
    let validAtMs: Int64
    let invalidAtMs: Int64?
    let invalidatedByMemoryId: String?
    let createdByKind: String
    let createdByMemberId: String?
    let createdAtMs: Int64
    let updatedAtMs: Int64
    let sourceRefs: [MemorySourceRefDTO]
}

struct MemoryItemResponse: ResponseEncodable {
    let memory: MemoryItemDTO
}

struct MemoryPageResponse: ResponseEncodable {
    let memories: [MemoryItemDTO]
}

struct MemoryPolicyDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let workspaceId: String
    let enabled: Bool
    let updatedBy: String?
    let updatedAtMs: Int64?
}

struct MemoryPolicyResponse: ResponseEncodable {
    let memoryPolicy: MemoryPolicyDTO
    let deletedCount: Int?
}

/// ADR-0129 Memory Plane CRUD and lifecycle surface.
///
/// All access runs through the ordinary tenant transaction. Source rows are
/// identifiers only and every create verifies that the actor can still read
/// each source channel. Individual DELETE is intentionally absent: normal
/// removal is an invalidation, while workspace administrators can disable the
/// policy and purge the entire projection in one transaction.
struct MemoryRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/memories", use: list)
        group.post("/v1/workspaces/:ws/memories", use: create)
        group.patch("/v1/workspaces/:ws/memories/:memory", use: update)
        group.post("/v1/workspaces/:ws/memories/:memory/invalidate", use: invalidate)
        group.delete("/v1/workspaces/:ws/memories", use: disableAndDeleteAll)
        group.get("/v1/workspaces/:ws/memory-policy", use: getPolicy)
        group.put("/v1/workspaces/:ws/memory-policy", use: putPolicy)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.scope(context)
        let query = request.uri.queryParameters
        let scope = try Self.optionalEnum(
            query["scope"].map(String.init), allowed: Self.scopes, label: "scope"
        )
        let agentID = try Self.optionalUUID(query["agent"].map(String.init), label: "agent")
        let includeInvalid = query["includeInvalid"] == "true"
        let limit = min(max(query["limit"].flatMap { Int($0) } ?? 50, 1), 200)

        let items = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireMember(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT mi.id, mi.scope, mi.subject_member_id, mi.agent_member_id,
                       mi.channel_id, mi.kind, mi.body, mi.confidence, mi.valid_at,
                       mi.invalid_at, mi.invalidated_by_memory_id, mi.created_by_kind,
                       mi.created_by_member_id, mi.created_at, mi.updated_at
                  FROM memory_item mi
                 WHERE mi.workspace_id = \(workspaceID)
                   AND (\(scope)::text IS NULL OR mi.scope = \(scope)::text)
                   AND (\(agentID)::uuid IS NULL OR mi.agent_member_id = \(agentID)::uuid)
                   AND (\(includeInvalid) OR mi.invalid_at IS NULL)
                   AND EXISTS (
                     SELECT 1
                       FROM memory_source_ref msr
                       JOIN membership ms
                         ON ms.workspace_id = msr.workspace_id
                        AND ms.channel_id = msr.channel_id
                        AND ms.member_id = \(principal.memberID)
                        AND ms.left_at IS NULL
                      WHERE msr.workspace_id = mi.workspace_id
                        AND msr.memory_id = mi.id
                   )
                 ORDER BY mi.valid_at DESC, mi.id DESC
                 LIMIT \(limit)
                """,
                logger: db.logger
            ).collect()
            return try await rows.asyncMap { row in
                try await Self.decode(row, conn: conn, logger: db.logger, workspaceID: workspaceID)
            }
        }
        return try MemoryPageResponse(memories: items).response(from: request, context: context)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.scope(context)
        let input = try await request.decode(as: CreateMemoryRequest.self, context: context)
        let validated = try Self.validateCreate(input)

        let item = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireMember(
                conn: conn, logger: db.logger, principal: principal
            )
            try await Self.requirePolicyEnabled(
                conn: conn, logger: db.logger, workspaceID: workspaceID
            )
            try await Self.requireScopeSubjects(
                conn: conn, logger: db.logger, workspaceID: workspaceID, input: validated
            )
            try await Self.requireReadableSources(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                actorMemberID: principal.memberID,
                sources: validated.sourceRefs,
                conversationChannelID: validated.scope == "conversation" ? validated.channelId : nil
            )

            let validAt = validated.validAtMs.map { Date(timeIntervalSince1970: Double($0) / 1000) }
                ?? Date()
            let rows = try await conn.query(
                """
                INSERT INTO memory_item
                  (workspace_id, scope, subject_member_id, agent_member_id,
                   channel_id, kind, body, confidence, valid_at,
                   created_by_kind, created_by_member_id)
                VALUES
                  (\(workspaceID), \(validated.scope), \(validated.subjectMemberId)::uuid,
                   \(validated.agentMemberId)::uuid, \(validated.channelId)::uuid,
                   \(validated.kind), \(validated.body), \(validated.confidence),
                   \(validAt), \(principal.kind.rawValue), \(principal.memberID))
                RETURNING id, scope, subject_member_id, agent_member_id, channel_id,
                          kind, body, confidence, valid_at, invalid_at,
                          invalidated_by_memory_id, created_by_kind,
                          created_by_member_id, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "memory insert failed")
            }
            let memoryID = try row.decode((UUID, String, UUID?, UUID?, UUID?, String, String,
                                           Double, Date, Date?, UUID?, String, UUID?, Date, Date).self).0
            for source in validated.sourceRefs {
                _ = try await conn.query(
                    """
                    INSERT INTO memory_source_ref
                      (workspace_id, memory_id, message_id, channel_id)
                    VALUES
                      (\(workspaceID), \(memoryID), \(source.messageId), \(source.channelId))
                    """,
                    logger: db.logger
                )
            }
            try await Self.recordChange(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memoryID: memoryID,
                actor: principal,
                action: "created",
                eventType: "memory.updated",
                channels: Set(validated.sourceRefs.map(\.channelId)),
                detail: ["kind": validated.kind, "scope": validated.scope]
            )
            return try await Self.decode(
                row, conn: conn, logger: db.logger, workspaceID: workspaceID
            )
        }
        return try MemoryItemResponse(memory: item).response(from: request, context: context)
    }

    @Sendable
    func update(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.scope(context)
        let memoryID = try Self.memoryID(context)
        let input = try await request.decode(as: UpdateMemoryRequest.self, context: context)
        guard input.body != nil || input.confidence != nil else {
            throw HTTPError(.badRequest, message: "body or confidence is required")
        }
        let body = try input.body.map(Self.validatedBody)
        let confidence = try input.confidence.map(Self.validatedConfidence)

        let item = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            let role = try await WorkspaceAuthorization.requireMember(
                conn: conn, logger: db.logger, principal: principal
            )
            try await Self.requirePolicyEnabled(
                conn: conn, logger: db.logger, workspaceID: workspaceID
            )
            let ownerRows = try await conn.query(
                """
                SELECT created_by_member_id
                  FROM memory_item
                 WHERE workspace_id = \(workspaceID) AND id = \(memoryID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let ownerRow = ownerRows.first else {
                throw HTTPError(.notFound, message: "memory not found")
            }
            let ownerID = try ownerRow.decode(UUID?.self)
            guard role.isAdmin || ownerID == principal.memberID else {
                throw HTTPError(.forbidden, message: "memory edit requires its creator or workspace admin")
            }
            let rows = try await conn.query(
                """
                UPDATE memory_item
                   SET body = coalesce(\(body)::text, body),
                       confidence = coalesce(\(confidence)::double precision, confidence),
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(memoryID)
                   AND invalid_at IS NULL
                RETURNING id, scope, subject_member_id, agent_member_id, channel_id,
                          kind, body, confidence, valid_at, invalid_at,
                          invalidated_by_memory_id, created_by_kind,
                          created_by_member_id, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.conflict, message: "invalidated memory cannot be edited")
            }
            let channels = try await Self.sourceChannels(
                conn: conn, logger: db.logger, workspaceID: workspaceID, memoryID: memoryID
            )
            try await Self.recordChange(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memoryID: memoryID, actor: principal, action: "updated",
                eventType: "memory.updated", channels: channels,
                detail: ["body_changed": body != nil, "confidence_changed": confidence != nil]
            )
            return try await Self.decode(
                row, conn: conn, logger: db.logger, workspaceID: workspaceID
            )
        }
        return try MemoryItemResponse(memory: item).response(from: request, context: context)
    }

    @Sendable
    func invalidate(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.scope(context)
        let memoryID = try Self.memoryID(context)
        let input = try await request.decode(as: InvalidateMemoryRequest.self, context: context)
        guard input.invalidatedByMemoryId != memoryID else {
            throw HTTPError(.badRequest, message: "memory cannot invalidate itself")
        }

        let item = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            let role = try await WorkspaceAuthorization.requireMember(
                conn: conn, logger: db.logger, principal: principal
            )
            let ownerRows = try await conn.query(
                """
                SELECT created_by_member_id
                  FROM memory_item
                 WHERE workspace_id = \(workspaceID) AND id = \(memoryID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let ownerRow = ownerRows.first else {
                throw HTTPError(.notFound, message: "memory not found")
            }
            let ownerID = try ownerRow.decode(UUID?.self)
            guard role.isAdmin || ownerID == principal.memberID else {
                throw HTTPError(.forbidden, message: "memory invalidation requires its creator or workspace admin")
            }
            if let replacementID = input.invalidatedByMemoryId {
                let replacement = try await conn.query(
                    """
                    SELECT 1 FROM memory_item
                     WHERE workspace_id = \(workspaceID)
                       AND id = \(replacementID)
                       AND invalid_at IS NULL
                    """,
                    logger: db.logger
                ).collect()
                guard !replacement.isEmpty else {
                    throw HTTPError(.badRequest, message: "replacement memory is unavailable")
                }
            }
            let rows = try await conn.query(
                """
                UPDATE memory_item
                   SET invalid_at = coalesce(invalid_at, clock_timestamp()),
                       invalidated_by_memory_id = coalesce(
                         invalidated_by_memory_id, \(input.invalidatedByMemoryId)::uuid
                       ),
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID) AND id = \(memoryID)
                RETURNING id, scope, subject_member_id, agent_member_id, channel_id,
                          kind, body, confidence, valid_at, invalid_at,
                          invalidated_by_memory_id, created_by_kind,
                          created_by_member_id, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "memory not found")
            }
            let channels = try await Self.sourceChannels(
                conn: conn, logger: db.logger, workspaceID: workspaceID, memoryID: memoryID
            )
            try await Self.recordChange(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memoryID: memoryID, actor: principal, action: "invalidated",
                eventType: "memory.updated", channels: channels,
                detail: [
                    "invalidated_by_memory_id": input.invalidatedByMemoryId?.uuidString ?? NSNull()
                ]
            )
            return try await Self.decode(
                row, conn: conn, logger: db.logger, workspaceID: workspaceID
            )
        }
        return try MemoryItemResponse(memory: item).response(from: request, context: context)
    }

    @Sendable
    func getPolicy(_ request: Request, context: AppRequestContext) async throws -> Response {
        let (principal, workspaceID) = try Self.scope(context)
        let policy = try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            return try await Self.loadPolicy(conn: conn, logger: db.logger, workspaceID: workspaceID)
        }
        return try MemoryPolicyResponse(memoryPolicy: policy, deletedCount: nil)
            .response(from: request, context: context)
    }

    @Sendable
    func putPolicy(_ request: Request, context: AppRequestContext) async throws -> Response {
        let input = try await request.decode(as: PutMemoryPolicyRequest.self, context: context)
        if !input.enabled {
            return try await disableAndDeleteAll(request, context: context)
        }
        let (principal, workspaceID) = try Self.scope(context)
        let policy = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            _ = try await conn.query(
                """
                INSERT INTO workspace_memory_policy (workspace_id, enabled, updated_by)
                VALUES (\(workspaceID), true, \(principal.memberID))
                ON CONFLICT (workspace_id) DO UPDATE
                  SET enabled = true, updated_by = EXCLUDED.updated_by,
                      updated_at = clock_timestamp()
                """,
                logger: db.logger
            )
            try await Self.recordPolicyAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, enabled: true, deletedCount: 0
            )
            return try await Self.loadPolicy(conn: conn, logger: db.logger, workspaceID: workspaceID)
        }
        return try MemoryPolicyResponse(memoryPolicy: policy, deletedCount: 0)
            .response(from: request, context: context)
    }

    @Sendable
    func disableAndDeleteAll(
        _ request: Request, context: AppRequestContext
    ) async throws -> Response {
        let (principal, workspaceID) = try Self.scope(context)
        let result = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            _ = try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            _ = try await conn.query(
                """
                INSERT INTO workspace_memory_policy (workspace_id, enabled, updated_by)
                VALUES (\(workspaceID), false, \(principal.memberID))
                ON CONFLICT (workspace_id) DO UPDATE
                  SET enabled = false, updated_by = EXCLUDED.updated_by,
                      updated_at = clock_timestamp()
                """,
                logger: db.logger
            )
            let ids = try await conn.query(
                "SELECT id FROM memory_item WHERE workspace_id = \(workspaceID) FOR UPDATE",
                logger: db.logger
            ).collect().map { try $0.decode(UUID.self) }
            for id in ids {
                _ = try await conn.query(
                    """
                    INSERT INTO memory_lifecycle_event
                      (workspace_id, memory_id, action, actor_member_id, detail)
                    VALUES
                      (\(workspaceID), \(id), 'deleted', \(principal.memberID),
                       jsonb_build_object('memory_id', \(id), 'reason', 'workspace_policy_off'))
                    """,
                    logger: db.logger
                )
            }
            _ = try await conn.query(
                "DELETE FROM memory_candidate WHERE workspace_id = \(workspaceID)",
                logger: db.logger
            )
            _ = try await conn.query(
                "DELETE FROM memory_item WHERE workspace_id = \(workspaceID)",
                logger: db.logger
            )
            try await Self.recordPolicyAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                principal: principal, enabled: false, deletedCount: ids.count
            )
            let policy = try await Self.loadPolicy(
                conn: conn, logger: db.logger, workspaceID: workspaceID
            )
            return (policy, ids.count)
        }
        return try MemoryPolicyResponse(memoryPolicy: result.0, deletedCount: result.1)
            .response(from: request, context: context)
    }

    private static let scopes = ["workspace", "member", "agent", "conversation"]
    private static let kinds = ["profile", "fact", "episode", "procedure"]

    static func validateCreate(_ input: CreateMemoryRequest) throws -> CreateMemoryRequest {
        guard scopes.contains(input.scope) else {
            throw HTTPError(.badRequest, message: "invalid memory scope")
        }
        guard kinds.contains(input.kind) else {
            throw HTTPError(.badRequest, message: "invalid memory kind")
        }
        let body = try validatedBody(input.body)
        let confidence = try validatedConfidence(input.confidence)
        guard (1...32).contains(input.sourceRefs.count), Set(input.sourceRefs.map(\.messageId)).count == input.sourceRefs.count else {
            throw HTTPError(.badRequest, message: "sourceRefs must contain 1-32 unique messages")
        }
        switch input.scope {
        case "workspace":
            guard input.subjectMemberId == nil, input.agentMemberId == nil, input.channelId == nil else {
                throw HTTPError(.badRequest, message: "workspace scope cannot carry subject ids")
            }
        case "member":
            guard input.subjectMemberId != nil, input.agentMemberId == nil, input.channelId == nil else {
                throw HTTPError(.badRequest, message: "member scope requires subjectMemberId only")
            }
        case "agent":
            guard input.subjectMemberId == nil, input.agentMemberId != nil, input.channelId == nil else {
                throw HTTPError(.badRequest, message: "agent scope requires agentMemberId only")
            }
        case "conversation":
            guard input.subjectMemberId == nil, input.channelId != nil else {
                throw HTTPError(.badRequest, message: "conversation scope requires channelId")
            }
        default: break
        }
        if let value = input.validAtMs, value < 0 {
            throw HTTPError(.badRequest, message: "validAtMs must be non-negative")
        }
        return CreateMemoryRequest(
            scope: input.scope, subjectMemberId: input.subjectMemberId,
            agentMemberId: input.agentMemberId, channelId: input.channelId,
            kind: input.kind, body: body, confidence: confidence,
            validAtMs: input.validAtMs, sourceRefs: input.sourceRefs
        )
    }

    static func validatedBody(_ raw: String) throws -> String {
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...16_384).contains(body.count) else {
            throw HTTPError(.badRequest, message: "memory body must be 1-16384 characters")
        }
        return body
    }

    static func validatedConfidence(_ value: Double) throws -> Double {
        guard value.isFinite, (0...1).contains(value) else {
            throw HTTPError(.badRequest, message: "confidence must be between 0 and 1")
        }
        return value
    }

    private static func requireScopeSubjects(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        input: CreateMemoryRequest
    ) async throws {
        let memberID = input.subjectMemberId ?? input.agentMemberId
        if let memberID {
            let expectedKind: String? = input.scope == "agent" ? "agent" : nil
            let rows = try await conn.query(
                """
                SELECT kind::text
                  FROM member
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(memberID)
                   AND status = 'active'
                   AND deleted_at IS NULL
                """,
                logger: logger
            ).collect()
            guard let raw = try rows.first?.decode(String.self), expectedKind == nil || raw == expectedKind else {
                throw HTTPError(.badRequest, message: "memory subject is unavailable")
            }
        }
    }

    private static func requireReadableSources(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorMemberID: UUID,
        sources: [MemorySourceRefRequest],
        conversationChannelID: UUID?
    ) async throws {
        for source in sources {
            if let conversationChannelID, conversationChannelID != source.channelId {
                throw HTTPError(.badRequest, message: "conversation memory sources must use its channel")
            }
            let rows = try await conn.query(
                """
                SELECT 1
                  FROM message m
                  JOIN membership ms
                    ON ms.workspace_id = m.workspace_id
                   AND ms.channel_id = m.channel_id
                   AND ms.member_id = \(actorMemberID)
                   AND ms.left_at IS NULL
                 WHERE m.workspace_id = \(workspaceID)
                   AND m.id = \(source.messageId)
                   AND m.channel_id = \(source.channelId)
                   AND m.deleted_at IS NULL
                """,
                logger: logger
            ).collect()
            guard !rows.isEmpty else {
                throw HTTPError(.forbidden, message: "memory source is unavailable to this actor")
            }
        }
    }

    private static func requirePolicyEnabled(
        conn: PostgresConnection, logger: Logger, workspaceID: UUID
    ) async throws {
        let rows = try await conn.query(
            "SELECT enabled FROM workspace_memory_policy WHERE workspace_id = \(workspaceID)",
            logger: logger
        ).collect()
        if let row = rows.first, try !row.decode(Bool.self) {
            throw HTTPError(.conflict, message: "workspace memory is disabled")
        }
    }

    private static func sourceChannels(
        conn: PostgresConnection, logger: Logger, workspaceID: UUID, memoryID: UUID
    ) async throws -> Set<UUID> {
        let rows = try await conn.query(
            """
            SELECT DISTINCT channel_id
              FROM memory_source_ref
             WHERE workspace_id = \(workspaceID) AND memory_id = \(memoryID)
            """,
            logger: logger
        ).collect()
        return Set(try rows.map { try $0.decode(UUID.self) })
    }

    private static func recordChange(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        memoryID: UUID,
        actor: AuthPrincipal,
        action: String,
        eventType: String,
        channels: Set<UUID>,
        detail: [String: Any]
    ) async throws {
        let detailJSON = jsonString(detail)
        _ = try await conn.query(
            """
            INSERT INTO memory_lifecycle_event
              (workspace_id, memory_id, action, actor_member_id, detail)
            VALUES
              (\(workspaceID), \(memoryID), \(action), \(actor.memberID),
               \(detailJSON)::jsonb)
            """,
            logger: logger
        )
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(actor.memberID), 'memory.' || \(action),
               'memory', \(memoryID), \(actor.tokenID), \(detailJSON)::jsonb)
            """,
            logger: logger
        )
        for channelID in channels.sorted(by: { $0.uuidString < $1.uuidString }) {
            let payload = broadcastPayload(
                workspaceID: workspaceID, channelID: channelID,
                memoryID: memoryID, eventType: eventType, action: action
            )
            _ = try await conn.query(
                """
                INSERT INTO outbox
                  (workspace_id, kind, method, payload, partition_key)
                VALUES
                  (\(workspaceID), 'broadcast', 'publish', \(payload)::jsonb, \(channelID))
                """,
                logger: logger
            )
        }
    }

    private static func recordPolicyAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        principal: AuthPrincipal,
        enabled: Bool,
        deletedCount: Int
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id,
               via_token_id, detail)
            VALUES
              (\(workspaceID), \(principal.memberID), 'memory.policy.updated',
               'workspace_memory_policy', \(workspaceID), \(principal.tokenID),
               jsonb_build_object('enabled', \(enabled), 'deleted_count', \(deletedCount)))
            """,
            logger: logger
        )
    }

    private static func loadPolicy(
        conn: PostgresConnection, logger: Logger, workspaceID: UUID
    ) async throws -> MemoryPolicyDTO {
        let rows = try await conn.query(
            """
            SELECT enabled, updated_by, updated_at
              FROM workspace_memory_policy
             WHERE workspace_id = \(workspaceID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            return MemoryPolicyDTO(
                workspaceId: workspaceID.uuidString, enabled: true,
                updatedBy: nil, updatedAtMs: nil
            )
        }
        let (enabled, updatedBy, updatedAt) = try row.decode((Bool, UUID?, Date).self)
        return MemoryPolicyDTO(
            workspaceId: workspaceID.uuidString, enabled: enabled,
            updatedBy: updatedBy?.uuidString, updatedAtMs: epochMs(updatedAt)
        )
    }

    private static func decode(
        _ row: PostgresRow,
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID
    ) async throws -> MemoryItemDTO {
        let value = try row.decode((UUID, String, UUID?, UUID?, UUID?, String, String,
                                    Double, Date, Date?, UUID?, String, UUID?, Date, Date).self)
        let sources = try await conn.query(
            """
            SELECT message_id, channel_id
              FROM memory_source_ref
             WHERE workspace_id = \(workspaceID) AND memory_id = \(value.0)
             ORDER BY created_at, id
            """,
            logger: logger
        ).collect().map {
            let (messageID, channelID) = try $0.decode((UUID, UUID).self)
            return MemorySourceRefDTO(
                messageId: messageID.uuidString, channelId: channelID.uuidString
            )
        }
        return MemoryItemDTO(
            id: value.0.uuidString, workspaceId: workspaceID.uuidString,
            scope: value.1, subjectMemberId: value.2?.uuidString,
            agentMemberId: value.3?.uuidString, channelId: value.4?.uuidString,
            kind: value.5, body: value.6, confidence: value.7,
            validAtMs: epochMs(value.8), invalidAtMs: value.9.map(epochMs),
            invalidatedByMemoryId: value.10?.uuidString, createdByKind: value.11,
            createdByMemberId: value.12?.uuidString, createdAtMs: epochMs(value.13),
            updatedAtMs: epochMs(value.14), sourceRefs: sources
        )
    }

    static func broadcastPayload(
        workspaceID: UUID,
        channelID: UUID,
        memoryID: UUID,
        eventType: String,
        action: String,
        timestampMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    ) -> String {
        let channel = "ch:ws\(workspaceID.uuidString).\(channelID.uuidString)"
        return jsonString([
            "channel": channel,
            "data": [
                "type": eventType, "v": 1, "ts": timestampMs,
                "payload": [
                    "workspace_id": workspaceID.uuidString,
                    "channel_id": channelID.uuidString,
                    "memory_id": memoryID.uuidString,
                    "action": action,
                ],
            ],
            "idempotency_key": "\(channel):\(eventType):\(memoryID.uuidString):\(action):\(timestampMs)",
        ])
    }

    private static func scope(_ context: AppRequestContext) throws -> (AuthPrincipal, UUID) {
        let principal = try context.requirePrincipal()
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        return (principal, workspaceID)
    }

    private static func memoryID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("memory")
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid memory id")
        }
        return id
    }

    private static func optionalUUID(_ raw: String?, label: String) throws -> UUID? {
        guard let raw else { return nil }
        guard let id = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid \(label)")
        }
        return id
    }

    private static func optionalEnum(
        _ raw: String?, allowed: [String], label: String
    ) throws -> String? {
        guard let raw else { return nil }
        guard allowed.contains(raw) else {
            throw HTTPError(.badRequest, message: "invalid \(label)")
        }
        return raw
    }

    private static func epochMs(_ date: Date) -> Int64 {
        Int64(date.timeIntervalSince1970 * 1000)
    }

    private static func jsonString(_ object: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8)
        else { return "{}" }
        return value
    }
}

private extension Array where Element == PostgresRow {
    func asyncMap<T>(_ transform: (PostgresRow) async throws -> T) async rethrows -> [T] {
        var result: [T] = []
        result.reserveCapacity(count)
        for row in self { result.append(try await transform(row)) }
        return result
    }
}
