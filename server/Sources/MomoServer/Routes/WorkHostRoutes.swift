@preconcurrency import Crypto
import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct RegisterWorkHostRequest: Decodable {
    let scope: String
    let type: String
    let displayName: String
    let publicKey: String
    let capabilities: [String: Bool]?
}

struct WorkHostHeartbeatRequest: Decodable {
    let sentAtMs: Int64
    let signature: String
}

struct WorkHostDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let scope: String
    let ownerMemberId: String
    let type: String
    let displayName: String
    let publicKey: String
    let capabilities: [String: Bool]
    let lastSeenAtMs: Int64?
    let revokedAtMs: Int64?
    let createdAtMs: Int64
    let online: Bool
}

struct WorkHostResponse: ResponseEncodable {
    let workHost: WorkHostDTO
}

struct WorkHostListResponse: ResponseEncodable {
    let workHosts: [WorkHostDTO]
}

struct PendingWorkControlsResponse: ResponseEncodable {
    let workControls: [WorkControlDTO]
}

/// ADR-0125 D1/D8 durable work-host identity registry.
///
/// Protected human routes:
///   POST   /v1/workspaces/{ws}/work-hosts
///   GET    /v1/workspaces/{ws}/work-hosts
///   DELETE /v1/workspaces/{ws}/work-hosts/{host}
///
/// Protected host-signature route (MomoHost authorization, never bearer):
///   GET    /v1/workspaces/{ws}/work-hosts/{host}/pending-controls
///
/// Public signature-authenticated route (no durable bearer on the host):
///   POST   /v1/workspaces/{ws}/work-hosts/{host}/heartbeat
///
/// Heartbeats sign the UTF-8 bytes returned by `heartbeatSigningPayload`.
/// Private key material, credentials, paths, and process state never cross or
/// persist at this boundary. Capabilities are boolean availability flags only.
struct WorkHostRoutes: Sendable {
    static let onlineWindowSeconds: Int64 = 90
    static let heartbeatClockSkewMs: Int64 = 5 * 60 * 1_000

    let db: Database

    func addProtected(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/work-hosts", use: register)
        group.get("/v1/workspaces/:ws/work-hosts", use: list)
        group.get(
            "/v1/workspaces/:ws/work-hosts/:host/pending-controls",
            use: pendingControls
        )
        group.delete("/v1/workspaces/:ws/work-hosts/:host", use: revoke)
    }

    func addPublic(to router: Router<AppRequestContext>) {
        router.post("/v1/workspaces/:ws/work-hosts/:host/heartbeat", use: heartbeat)
    }

    @Sendable
    func register(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let requestDTO = try await request.decode(
            as: RegisterWorkHostRequest.self,
            context: context
        )
        let scope = try Self.validatedScope(requestDTO.scope)
        let type = try Self.validatedType(requestDTO.type)
        let displayName = try Self.validatedDisplayName(requestDTO.displayName)
        let publicKey = try Self.validatedPublicKey(requestDTO.publicKey)
        let capabilities = try Self.validatedCapabilities(requestDTO.capabilities)
        let capabilitiesJSON = Self.jsonString(capabilities)

        let host = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn,
                logger: db.logger,
                principal: principal
            )
            let rows = try await conn.query(
                """
                INSERT INTO work_host
                  (workspace_id, scope, owner_member_id, type, display_name,
                   public_key, capabilities)
                VALUES
                  (\(workspaceID), \(scope), \(principal.memberID), \(type),
                   \(displayName), \(publicKey), \(capabilitiesJSON)::jsonb)
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard let hostID = try rows.first?.decode(UUID.self) else {
                throw HTTPError(.internalServerError, message: "work host insert failed")
            }

            let detail = Self.jsonString([
                "schema": "momo.work_host.registered.v1",
                "scope": scope,
                "type": type,
                "capability_keys": capabilities.keys.sorted(),
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(principal.memberID),
                   'work.host.registered', 'work_host', \(hostID),
                   \(principal.tokenID), \(detail)::jsonb)
                """,
                logger: db.logger
            )
            return try await Self.loadHost(
                conn: conn,
                logger: db.logger,
                hostID: hostID
            )
        }

        var response = try WorkHostResponse(workHost: host)
            .response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)

        let hosts: [WorkHostDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn,
                logger: db.logger,
                principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT \(unescaped: Self.hostJSONSelect)
                  FROM work_host h
                 ORDER BY h.created_at, h.id
                """,
                logger: db.logger
            ).collect()
            return try rows.map { try Self.decodeHost($0.decode(String.self)) }
        }

        return try WorkHostListResponse(workHosts: hosts)
            .response(from: request, context: context)
    }

    @Sendable
    func heartbeat(_ request: Request, context: AppRequestContext) async throws -> Response {
        let workspaceID = try Self.publicWorkspaceID(context)
        let hostID = try Self.hostID(context)
        let requestDTO = try await request.decode(
            as: WorkHostHeartbeatRequest.self,
            context: context
        )
        try Self.validateHeartbeatTimestamp(requestDTO.sentAtMs)

        let host = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT public_key, revoked_at IS NULL AS active
                  FROM work_host
                 WHERE id = \(hostID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw Self.heartbeatUnauthorized()
            }
            let (publicKey, active) = try row.decode((String, Bool).self)
            guard active,
                  Self.verifyHeartbeatSignature(
                    publicKey: publicKey,
                    signature: requestDTO.signature,
                    workspaceID: workspaceID,
                    hostID: hostID,
                    sentAtMs: requestDTO.sentAtMs
                  )
            else {
                throw Self.heartbeatUnauthorized()
            }

            let updated = try await conn.query(
                """
                UPDATE work_host
                   SET last_seen_at = clock_timestamp()
                 WHERE id = \(hostID)
                   AND revoked_at IS NULL
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard updated.first != nil else {
                throw Self.heartbeatUnauthorized()
            }
            return try await Self.loadHost(
                conn: conn,
                logger: db.logger,
                hostID: hostID
            )
        }

        return try WorkHostResponse(workHost: host)
            .response(from: request, context: context)
    }

    @Sendable
    func pendingControls(
        _ request: Request,
        context: AppRequestContext
    ) async throws -> Response {
        let principal = try context.requirePrincipal()
        guard principal.kind == .workHost else {
            throw HTTPError(.forbidden, message: "pending controls require work host signature")
        }
        let workspaceID = try Self.publicWorkspaceID(context)
        let hostID = try Self.hostID(context)
        guard workspaceID == principal.workspaceID, hostID == principal.tokenID else {
            throw Self.heartbeatUnauthorized()
        }

        let controls: [WorkControlDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT wc.id, wc.workspace_id, wc.channel_id,
                       wc.requester_member_id, wc.target_host_id, wc.session_id,
                       wc.kind, wc.payload::text, wc.status,
                       wc.approval_message_id, wc.created_at, wc.updated_at
                  FROM work_control wc
                  JOIN work_host h
                    ON h.id = wc.target_host_id
                   AND h.workspace_id = wc.workspace_id
                   AND h.revoked_at IS NULL
                 WHERE wc.workspace_id = \(workspaceID)
                   AND wc.target_host_id = \(hostID)
                   AND wc.status = 'dispatched'
                 ORDER BY wc.created_at, wc.id
                 LIMIT 100
                """,
                logger: db.logger
            ).collect()
            return try rows.map(WorkControlRoutes.decodeControl)
        }

        return try PendingWorkControlsResponse(workControls: controls)
            .response(from: request, context: context)
    }

    @Sendable
    func revoke(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHumanPrincipal(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let hostID = try Self.hostID(context)

        let host = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            let membershipRole = try await WorkspaceAuthorization.activeRole(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                memberID: principal.memberID
            )
            guard let membershipRole else {
                throw HTTPError(.forbidden, message: "not a workspace member")
            }

            let rows = try await conn.query(
                """
                SELECT owner_member_id, revoked_at IS NOT NULL AS already_revoked
                  FROM work_host
                 WHERE id = \(hostID)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "work host not found")
            }
            let (ownerMemberID, alreadyRevoked) = try row.decode((UUID, Bool).self)
            let isAdmin = membershipRole.isAdmin
            guard ownerMemberID == principal.memberID || isAdmin else {
                throw HTTPError(.forbidden, message: "work host revoke requires owner or workspace admin")
            }

            _ = try await conn.query(
                """
                UPDATE work_host
                   SET revoked_at = COALESCE(revoked_at, clock_timestamp())
                 WHERE id = \(hostID)
                """,
                logger: db.logger
            )
            let detail = Self.jsonString([
                "schema": "momo.work_host.revoked.v1",
                "already_revoked": alreadyRevoked,
            ])
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(ownerMemberID),
                   'work.host.revoked', 'work_host', \(hostID),
                   \(principal.tokenID), \(detail)::jsonb)
                """,
                logger: db.logger
            )
            return try await Self.loadHost(
                conn: conn,
                logger: db.logger,
                hostID: hostID
            )
        }

        return try WorkHostResponse(workHost: host)
            .response(from: request, context: context)
    }

    static func validatedScope(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value == "member" || value == "workspace" else {
            throw HTTPError(.badRequest, message: "scope must be member or workspace")
        }
        return value
    }

    static func validatedType(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ["app", "workd", "cloud"].contains(value) else {
            throw HTTPError(.badRequest, message: "type must be app, workd, or cloud")
        }
        return value
    }

    static func validatedDisplayName(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.count <= 80 else {
            throw HTTPError(.badRequest, message: "displayName must contain 1...80 characters")
        }
        return value
    }

    static func validatedPublicKey(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let bytes = Data(base64Encoded: value), bytes.count == 32,
              (try? Curve25519.Signing.PublicKey(rawRepresentation: bytes)) != nil
        else {
            throw HTTPError(.badRequest, message: "publicKey must be a 32-byte Ed25519 raw key in base64")
        }
        return bytes.base64EncodedString()
    }

    static func validatedCapabilities(_ raw: [String: Bool]?) throws -> [String: Bool] {
        let capabilities = raw ?? [:]
        guard capabilities.count <= 64 else {
            throw HTTPError(.badRequest, message: "capabilities accepts at most 64 boolean flags")
        }
        for key in capabilities.keys {
            let valid = !key.isEmpty && key.count <= 64 && key.allSatisfy { character in
                character.isASCII
                    && (character.isLetter || character.isNumber || "._-".contains(character))
            }
            guard valid else {
                throw HTTPError(.badRequest, message: "capability keys must be 1...64 ASCII letters, digits, dot, underscore, or dash")
            }
        }
        return capabilities
    }

    static func heartbeatSigningPayload(
        workspaceID: UUID,
        hostID: UUID,
        sentAtMs: Int64
    ) -> Data {
        Data(
            "momo.work_host.heartbeat.v1\n"
                .appending(workspaceID.uuidString.lowercased())
                .appending("\n")
                .appending(hostID.uuidString.lowercased())
                .appending("\n")
                .appending(String(sentAtMs))
                .utf8
        )
    }

    static func verifyHeartbeatSignature(
        publicKey: String,
        signature: String,
        workspaceID: UUID,
        hostID: UUID,
        sentAtMs: Int64
    ) -> Bool {
        guard let keyBytes = Data(base64Encoded: publicKey), keyBytes.count == 32,
              let signatureBytes = Data(base64Encoded: signature), signatureBytes.count == 64,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: keyBytes)
        else { return false }
        return key.isValidSignature(
            signatureBytes,
            for: heartbeatSigningPayload(
                workspaceID: workspaceID,
                hostID: hostID,
                sentAtMs: sentAtMs
            )
        )
    }

    static func validateHeartbeatTimestamp(
        _ sentAtMs: Int64,
        now: Date = Date()
    ) throws {
        let nowMs = now.timeIntervalSince1970 * 1_000
        guard sentAtMs >= 0,
              abs(Double(sentAtMs) - nowMs) <= Double(heartbeatClockSkewMs)
        else {
            throw heartbeatUnauthorized()
        }
    }

    static func heartbeatUnauthorized() -> HTTPError {
        HTTPError(.unauthorized, message: "invalid work host heartbeat signature")
    }

    private static func requireHumanPrincipal(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "work host management requires a human bearer")
        }
        return principal
    }

    private static func publicWorkspaceID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("ws")
        guard let workspaceID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        return workspaceID
    }

    private static func hostID(_ context: AppRequestContext) throws -> UUID {
        let raw = try context.parameters.require("host")
        guard let hostID = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid work host id")
        }
        return hostID
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

    static let hostJSONSelect = """
        jsonb_build_object(
          'id', h.id,
          'workspaceId', h.workspace_id,
          'scope', h.scope,
          'ownerMemberId', h.owner_member_id,
          'type', h.type,
          'displayName', h.display_name,
          'publicKey', h.public_key,
          'capabilities', h.capabilities,
          'lastSeenAtMs',
            CASE WHEN h.last_seen_at IS NULL THEN NULL
                 ELSE floor(extract(epoch from h.last_seen_at) * 1000)::bigint END,
          'revokedAtMs',
            CASE WHEN h.revoked_at IS NULL THEN NULL
                 ELSE floor(extract(epoch from h.revoked_at) * 1000)::bigint END,
          'createdAtMs', floor(extract(epoch from h.created_at) * 1000)::bigint,
          'online', h.revoked_at IS NULL
                    AND COALESCE(
                      h.last_seen_at >= clock_timestamp()
                        - make_interval(secs => \(onlineWindowSeconds)),
                      false)
        )::text
        """

    private static func loadHost(
        conn: PostgresConnection,
        logger: Logger,
        hostID: UUID
    ) async throws -> WorkHostDTO {
        let rows = try await conn.query(
            """
            SELECT \(unescaped: Self.hostJSONSelect)
              FROM work_host h
             WHERE h.id = \(hostID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "work host reload failed")
        }
        return try decodeHost(row.decode(String.self))
    }

    private static func decodeHost(_ json: String) throws -> WorkHostDTO {
        guard let data = json.data(using: .utf8),
              let host = try? JSONDecoder().decode(WorkHostDTO.self, from: data)
        else {
            throw HTTPError(.internalServerError, message: "work host JSON decoding failed")
        }
        return host
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
