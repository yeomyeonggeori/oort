import Foundation
import Hummingbird
import Logging
import PostgresNIO

/// APNs device / push-token registration lifecycle (MOMO-403, ADR-0120 D4).
///
///   POST   /v1/workspaces/{ws}/devices           register (idempotent upsert)
///   GET    /v1/workspaces/{ws}/devices           list the caller's own devices
///   DELETE /v1/workspaces/{ws}/devices/{device}  revoke (invalidate tokens)
///
/// Path shape: ADR-0120 D4 sketches `POST /v1/devices`, but every protected
/// tenant-data surface in this server is workspace-scoped
/// (`/v1/workspaces/:ws/...` + the uniform "path ws == JWT ws else 403"
/// guard — InviteRoutes/ChannelRoutes/DMRoutes/ReadStateRoutes/...), and
/// `device`/`push_token` carry NOT NULL workspace_id under FORCE RLS
/// ws_isolation. The workspace-scoped form is the same operation with the
/// tenant made explicit, so registration keeps the repo-wide guard + RLS
/// path identical to all other routes (member-scoped `/v1/devices` would be
/// the only tenant-CRUD exception).
///
/// Contracts:
/// - Actor binding: a member can only register/list/revoke their OWN
///   device/push_token; touching another member's device or active token is
///   403. Listing filters to `member_id = principal`.
/// - Idempotent upsert: re-registering the same client-stable deviceId
///   refreshes `last_seen_at`/`app_build` and rotates the push token — any
///   other still-active token on the same (device, env) is invalidated in
///   the same transaction (010 partial unique index enforces one active
///   token per device+env).
/// - Revocation is `invalidated_at = now()`, never DELETE:
///   `push_dispatch_log.push_token_id` must keep resolving (ADR-0120 D4,
///   DEPLOY.md APNs 410/400 → invalidated_at uses the same column).
/// - Responses and audit rows never carry the raw hex apns_token — only the
///   trailing `apnsTokenSuffix` (registration receipt is ref/suffix only).
/// - Every mutation writes an `audit_log` row in the same tenant
///   transaction (RLS FORCE path via `Database.withTenantTransaction`).
struct DeviceRoutes: Sendable {
    let db: Database

    func add(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/devices", use: register)
        group.get("/v1/workspaces/:ws/devices", use: list)
        group.delete("/v1/workspaces/:ws/devices/:device", use: revoke)
    }

    /// PostgresNIO wraps any error thrown inside `withTransaction` in
    /// `PostgresTransactionError`, which Hummingbird would render as a 500.
    /// The guard failures below (403/404/409) are intended responses, so
    /// unwrap them back into their `HTTPError` after the rollback.
    /// (AgentGatewayRoutes crosses expected 4xx as enum values instead; the
    /// guard set here is larger, so a single unwrap keeps handlers linear.)
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

    // MARK: - POST /v1/workspaces/{ws}/devices

    @Sendable
    func register(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let dto = try await request.decode(as: RegisterDeviceRequest.self, context: context)
        let deviceID = try Self.validatedDeviceID(dto.deviceId)
        let platform = try Self.normalizedPlatform(dto.platform)
        let apnsToken = try Self.normalizedApnsToken(dto.apnsToken)
        let env = try Self.normalizedEnv(dto.env)
        let topic = try Self.normalizedTopic(dto.topic)
        let appBuild = try Self.validatedAppBuild(dto.appBuild)

        let outcome: (device: DeviceDTO, created: Bool) = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireActiveMember(conn: conn, logger: db.logger, principal: principal)

            // 1) Actor binding on the device row. deviceId is client-stable,
            //    so an existing row must already belong to the caller.
            let deviceRows = try await conn.query(
                """
                SELECT member_id, platform::text FROM device WHERE id = \(deviceID)
                """,
                logger: db.logger
            ).collect()
            if let row = deviceRows.first {
                let (ownerID, existingPlatform) = try row.decode((UUID, String).self)
                guard ownerID == principal.memberID else {
                    throw HTTPError(.forbidden, message: "device belongs to another member")
                }
                guard existingPlatform == platform else {
                    throw HTTPError(.conflict, message: "device platform cannot change")
                }
            }

            // 2) Idempotent device upsert (re-registration = liveness refresh).
            let upsertRows = try await conn.query(
                """
                INSERT INTO device (id, workspace_id, member_id, platform, app_build)
                VALUES (\(deviceID), \(workspaceID), \(principal.memberID),
                        \(platform)::device_platform, \(appBuild))
                ON CONFLICT (id) DO UPDATE
                   SET app_build = EXCLUDED.app_build,
                       last_seen_at = now()
                RETURNING (xmax = 0) AS created
                """,
                logger: db.logger
            ).collect()
            guard let created = try upsertRows.first?.decode(Bool.self) else {
                throw HTTPError(.internalServerError, message: "device upsert failed")
            }

            // 3) Actor binding on the token: an ACTIVE (apns_token, env) row
            //    owned by another member is a hard 403. An invalidated row is
            //    reclaimable (account switch on the same physical device after
            //    logout revoked it).
            let tokenRows = try await conn.query(
                """
                SELECT id, member_id, invalidated_at IS NULL AS active
                  FROM push_token
                 WHERE apns_token = \(apnsToken) AND env = \(env)::push_env
                """,
                logger: db.logger
            ).collect()
            var existingTokenID: UUID?
            if let row = tokenRows.first {
                let (tokenID, ownerID, active) = try row.decode((UUID, UUID, Bool).self)
                if active && ownerID != principal.memberID {
                    throw HTTPError(.forbidden, message: "push token is registered to another member")
                }
                existingTokenID = tokenID
            }

            // 4) Token rotation: invalidate every other still-active token on
            //    the same (device, env) BEFORE the upsert so the 010 partial
            //    unique index (one active token per device+env) always holds.
            //    Rows are kept — push_dispatch_log references them.
            let rotatedRows = try await conn.query(
                """
                UPDATE push_token
                   SET invalidated_at = now(), updated_at = now()
                 WHERE device_id = \(deviceID)
                   AND env = \(env)::push_env
                   AND invalidated_at IS NULL
                   AND apns_token <> \(apnsToken)
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            let rotatedCount = rotatedRows.count

            // 5) Upsert the incoming token.
            if let existingTokenID {
                _ = try await conn.query(
                    """
                    UPDATE push_token
                       SET device_id = \(deviceID),
                           member_id = \(principal.memberID),
                           topic = \(topic),
                           invalidated_at = NULL,
                           updated_at = now()
                     WHERE id = \(existingTokenID)
                    """,
                    logger: db.logger
                )
            } else {
                // ON CONFLICT DO NOTHING: a conflicting row that RLS hides
                // (same apns_token registered under another tenant) must not
                // surface as a 500 — map it to an explicit conflict.
                let insertedRows = try await conn.query(
                    """
                    INSERT INTO push_token
                      (workspace_id, device_id, member_id, apns_token, env, topic)
                    VALUES (\(workspaceID), \(deviceID), \(principal.memberID),
                            \(apnsToken), \(env)::push_env, \(topic))
                    ON CONFLICT (apns_token, env) DO NOTHING
                    RETURNING id
                    """,
                    logger: db.logger
                ).collect()
                guard insertedRows.first != nil else {
                    throw HTTPError(.conflict, message: "push token is already registered in another workspace")
                }
            }

            // 6) Audit — same transaction; suffix only, never the raw token.
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, detail)
                VALUES (
                  \(workspaceID),
                  \(principal.memberID),
                  'device.registered',
                  'device',
                  \(deviceID),
                  \(principal.tokenID),
                  jsonb_build_object(
                    'schema', 'momo.device.registered.v1',
                    'platform', \(platform),
                    'env', \(env),
                    'topic', \(topic),
                    'apns_token_suffix', right(\(apnsToken), 8),
                    'device_created', \(created),
                    'tokens_rotated', \(rotatedCount)
                  )
                )
                """,
                logger: db.logger
            )

            let device = try await Self.loadDevice(
                conn: conn, logger: db.logger, deviceID: deviceID
            )
            return (device, created)
        }

        var response = try RegisterDeviceResponse(device: outcome.device)
            .response(from: request, context: context)
        response.status = outcome.created ? .created : .ok
        return response
    }

    // MARK: - GET /v1/workspaces/{ws}/devices

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)

        let devices: [DeviceDTO] = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT \(unescaped: Self.deviceJSONSelect)
                  FROM device d
                 WHERE d.member_id = \(principal.memberID)
                 ORDER BY d.created_at
                """,
                logger: db.logger
            ).collect()
            return try rows.map { try Self.decodeDevice($0.decode(String.self)) }
        }

        return try DeviceListResponse(devices: devices).response(from: request, context: context)
    }

    // MARK: - DELETE /v1/workspaces/{ws}/devices/{device}

    @Sendable
    func revoke(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try context.requirePrincipal()
        let workspaceID = try Self.workspaceID(context, principal: principal)
        let deviceID = try Self.deviceID(context)

        let outcome: (device: DeviceDTO, invalidated: Int) = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await Self.requireActiveMember(conn: conn, logger: db.logger, principal: principal)

            let deviceRows = try await conn.query(
                "SELECT member_id FROM device WHERE id = \(deviceID)",
                logger: db.logger
            ).collect()
            guard let row = deviceRows.first else {
                throw HTTPError(.notFound, message: "device not found")
            }
            guard try row.decode(UUID.self) == principal.memberID else {
                throw HTTPError(.forbidden, message: "device belongs to another member")
            }

            // Revocation = invalidated_at, never DELETE (dispatch_log FK
            // preservation). Idempotent: an already-revoked device reports 0.
            let invalidatedRows = try await conn.query(
                """
                UPDATE push_token
                   SET invalidated_at = now(), updated_at = now()
                 WHERE device_id = \(deviceID)
                   AND invalidated_at IS NULL
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            let invalidated = invalidatedRows.count

            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, detail)
                VALUES (
                  \(workspaceID),
                  \(principal.memberID),
                  'device.revoked',
                  'device',
                  \(deviceID),
                  \(principal.tokenID),
                  jsonb_build_object(
                    'schema', 'momo.device.revoked.v1',
                    'tokens_invalidated', \(invalidated)
                  )
                )
                """,
                logger: db.logger
            )

            let device = try await Self.loadDevice(
                conn: conn, logger: db.logger, deviceID: deviceID
            )
            return (device, invalidated)
        }

        return try RevokeDeviceResponse(
            device: outcome.device, invalidatedCount: outcome.invalidated
        ).response(from: request, context: context)
    }

    // MARK: - Guard helpers

    static func workspaceID(
        _ context: AppRequestContext,
        principal: AuthPrincipal
    ) throws -> UUID {
        let wsParam = try context.parameters.require("ws")
        guard let ws = UUID(uuidString: wsParam) else {
            throw HTTPError(.badRequest, message: "invalid workspace id")
        }
        guard ws == principal.workspaceID else {
            throw HTTPError(.forbidden, message: "workspace scope mismatch")
        }
        return ws
    }

    static func deviceID(_ context: AppRequestContext) throws -> UUID {
        let param = try context.parameters.require("device")
        guard let device = UUID(uuidString: param) else {
            throw HTTPError(.badRequest, message: "invalid device id")
        }
        return device
    }

    static func requireActiveMember(
        conn: PostgresConnection,
        logger: Logger,
        principal: AuthPrincipal
    ) async throws {
        let rows = try await conn.query(
            "SELECT status::text FROM member WHERE id = \(principal.memberID)",
            logger: logger
        ).collect()
        guard let status = try rows.first?.decode(String.self) else {
            throw HTTPError(.forbidden, message: "not a workspace member")
        }
        guard status == "active" else {
            throw HTTPError(.forbidden, message: "member is not active in this workspace")
        }
    }

    // MARK: - Validation (unit-tested)

    static func validatedDeviceID(_ raw: String) throws -> UUID {
        guard let id = UUID(uuidString: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw HTTPError(.badRequest, message: "deviceId must be a UUID")
        }
        return id
    }

    static func normalizedPlatform(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ["ios", "macos"].contains(value) else {
            throw HTTPError(.badRequest, message: "platform must be ios or macos")
        }
        return value
    }

    static func normalizedEnv(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ["sandbox", "production"].contains(value) else {
            throw HTTPError(.badRequest, message: "env must be sandbox or production")
        }
        return value
    }

    /// APNs device tokens are hex (today 64 chars; Apple documents the length
    /// as variable, so allow a generous range). Normalized to lowercase so the
    /// UNIQUE (apns_token, env) arbitration is case-stable.
    static func normalizedApnsToken(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard (16...512).contains(value.count),
              value.allSatisfy({ $0.isHexDigit && $0.isASCII })
        else {
            throw HTTPError(.badRequest, message: "apnsToken must be a hex device token")
        }
        return value
    }

    static func normalizedTopic(_ raw: String) throws -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let isClean = value.allSatisfy { char in
            !char.isWhitespace && char.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7F }
        }
        guard !value.isEmpty, value.count <= 256, isClean else {
            throw HTTPError(.badRequest, message: "topic must be a bundle id (1-256 chars, no whitespace)")
        }
        return value
    }

    static func validatedAppBuild(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty { return nil }
        guard value.count <= 64 else {
            throw HTTPError(.badRequest, message: "appBuild must be at most 64 chars")
        }
        return value
    }

    // MARK: - JSON mapping

    /// Shared SELECT fragment: one device row rendered as the wire DTO. The
    /// raw apns_token never leaves the database — `right(..., 8)` only.
    static let deviceJSONSelect = """
        jsonb_build_object(
          'id', d.id,
          'workspaceId', d.workspace_id,
          'memberId', d.member_id,
          'platform', d.platform::text,
          'appBuild', d.app_build,
          'lastSeenAtMs', floor(extract(epoch from d.last_seen_at) * 1000)::bigint,
          'createdAtMs', floor(extract(epoch from d.created_at) * 1000)::bigint,
          'pushTokens', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                     'id', t.id,
                     'deviceId', t.device_id,
                     'env', t.env::text,
                     'topic', t.topic,
                     'apnsTokenSuffix', right(t.apns_token, 8),
                     'invalidatedAtMs',
                       CASE WHEN t.invalidated_at IS NULL
                            THEN NULL
                            ELSE floor(extract(epoch from t.invalidated_at) * 1000)::bigint
                       END,
                     'createdAtMs', floor(extract(epoch from t.created_at) * 1000)::bigint,
                     'updatedAtMs', floor(extract(epoch from t.updated_at) * 1000)::bigint
                   ) ORDER BY t.created_at)
              FROM push_token t
             WHERE t.device_id = d.id
          ), '[]'::jsonb)
        )::text
        """

    static func loadDevice(
        conn: PostgresConnection,
        logger: Logger,
        deviceID: UUID
    ) async throws -> DeviceDTO {
        let rows = try await conn.query(
            """
            SELECT \(unescaped: Self.deviceJSONSelect)
              FROM device d
             WHERE d.id = \(deviceID)
            """,
            logger: logger
        ).collect()
        guard let row = rows.first else {
            throw HTTPError(.internalServerError, message: "device reload failed")
        }
        return try Self.decodeDevice(row.decode(String.self))
    }

    static func decodeDevice(_ json: String) throws -> DeviceDTO {
        guard let data = json.data(using: .utf8) else {
            throw HTTPError(.internalServerError, message: "device JSON encoding failed")
        }
        do {
            return try JSONDecoder().decode(DeviceDTO.self, from: data)
        } catch {
            throw HTTPError(.internalServerError, message: "device JSON decoding failed")
        }
    }
}
