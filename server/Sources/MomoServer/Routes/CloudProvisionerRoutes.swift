import AsyncHTTPClient
import Crypto
import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct CreateCloudHostRequest: Decodable {
    let displayName: String
    let confirmPaidCloud: Bool
    let idempotencyRef: String
}

struct CloudHostDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let provisionId: String
    let hostId: String?
    let state: String
    let provider: String
    let createdAtMs: Int64
}

struct CloudHostResponse: ResponseEncodable {
    let cloudHost: CloudHostDTO
}

/// ADR-0136 server-side T3 provisioner.
///
/// Create is a one-shot paid-cloud opt-in. E2B receives a short-lived bootstrap
/// token and starts the operator-owned workd template; cloud workd then creates
/// its own Ed25519 key and consumes that token at `register`. The E2B team key
/// remains process-only configuration.
struct CloudProvisionerRoutes: Sendable {
    static let bootstrapTTLSeconds: TimeInterval = 15 * 60

    let db: Database
    let httpClient: HTTPClient
    let config: CloudProvisionerConfig

    func addProtected(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/work-hosts/cloud", use: create)
        group.get("/v1/workspaces/:ws/work-hosts/cloud/:provision", use: get)
        group.post("/v1/workspaces/:ws/work-hosts/:host/cloud/pause", use: pause)
        group.post("/v1/workspaces/:ws/work-hosts/:host/cloud/resume", use: resume)
        group.delete("/v1/workspaces/:ws/work-hosts/:host/cloud", use: destroy)
    }

    func addPublic(to router: Router<AppRequestContext>) {
        router.post("/v1/workspaces/:ws/work-hosts/cloud/register", use: register)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let input = try await request.decode(as: CreateCloudHostRequest.self, context: context)
        guard input.confirmPaidCloud else {
            throw HTTPError(
                .badRequest,
                message: "momo Cloud는 유료 실행입니다. 명시적으로 동의한 뒤 다시 요청하세요."
            )
        }
        let displayName = try WorkHostRoutes.validatedDisplayName(input.displayName)
        let readyConfig = try Self.readyConfig(config)
        let expiresAt = Date().addingTimeInterval(Self.bootstrapTTLSeconds)
        guard let createKey = UUID(uuidString: input.idempotencyRef) else {
            throw HTTPError(.badRequest, message: "idempotencyRef must be a UUID")
        }

        let (provisionID, needsProviderCreate): (UUID, Bool) =
            try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn, logger: db.logger, principal: principal
            )
            let existingRows = try await conn.query(
                """
                SELECT id, requested_display_name, provider_sandbox_id IS NULL
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND create_idempotency_key = \(createKey)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            if let existingRow = existingRows.first {
                let (existingID, existingName, missingSandbox) =
                    try existingRow.decode((UUID, String?, Bool).self)
                guard existingName == nil || existingName == displayName else {
                    throw HTTPError(
                        .conflict,
                        message: "idempotencyRef was already used with a different displayName"
                    )
                }
                return (existingID, missingSandbox)
            }
            try await CloudUsageLedger.reserveProvisioningSlot(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
            let idRows = try await conn.query("SELECT uuidv7()", logger: db.logger).collect()
            guard let provisionID = try idRows.first?.decode(UUID.self) else {
                throw HTTPError(.internalServerError, message: "momo Cloud 요청 ID를 만들지 못했습니다.")
            }
            let token = Self.bootstrapToken(
                provisionID: provisionID,
                apiKey: readyConfig.apiKey
            )
            let digest = Self.tokenDigest(token)
            _ = try await conn.query(
                """
                INSERT INTO work_cloud_host
                  (id, workspace_id, requester_member_id, bootstrap_token_digest,
                   bootstrap_expires_at, unit_rate_micro_usd_second,
                   create_idempotency_key, requested_display_name)
                VALUES
                  (\(provisionID), \(workspaceID), \(principal.memberID), \(digest),
                   \(expiresAt), \(readyConfig.unitRateMicroUSDSecond),
                   \(createKey), \(displayName))
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(principal.memberID),
                   'work.cloud.provision.requested', 'work_cloud_host', \(provisionID),
                   \(principal.tokenID),
                   jsonb_build_object(
                     'schema', 'momo.work_cloud.provision.requested.v1',
                     'provider', 'e2b',
                     'paid_cloud_confirmed', true
                   ))
                """,
                logger: db.logger
            )
            return (provisionID, true)
        }

        if !needsProviderCreate {
            return try await cloudHostResponse(
                request: request,
                context: context,
                workspaceID: workspaceID,
                provisionID: provisionID
            )
        }
        let token = Self.bootstrapToken(
            provisionID: provisionID,
            apiKey: readyConfig.apiKey
        )

        let sandbox: CloudSandbox
        do {
            sandbox = try await E2BProvisioner(
                httpClient: httpClient, config: readyConfig
            ).create(
                provisionID: provisionID,
                workspaceID: workspaceID,
                registrationToken: token,
                displayName: displayName
            )
        } catch {
            // A timeout/invalid response is ambiguous: E2B may have committed a
            // paid sandbox. Keep the durable provisioning intent so the same
            // provider idempotency key can replay and converge it.
            throw Self.httpError(error)
        }

        let cloudHost: CloudHostDTO
        do {
            cloudHost = try await withTenantTransactionUnwrapped(
                workspaceID: workspaceID
            ) { conn in
                let rows = try await conn.query(
                    """
                    UPDATE work_cloud_host
                       SET provider_sandbox_id = \(sandbox.id),
                           state = CASE WHEN host_id IS NULL THEN 'provisioning' ELSE 'ready' END,
                           updated_at = clock_timestamp()
                     WHERE id = \(provisionID)
                       AND state = 'provisioning'
                    RETURNING id, host_id, state, provider, created_at
                    """,
                    logger: db.logger
                ).collect()
                guard let row = rows.first else {
                    throw HTTPError(.conflict, message: "momo Cloud 요청 상태가 변경되었습니다.")
                }
                return try Self.decodeCloudHost(row)
            }
        } catch {
            try? await E2BProvisioner(httpClient: httpClient, config: readyConfig)
                .destroy(sandboxID: sandbox.id)
            throw error
        }

        var response = try CloudHostResponse(cloudHost: cloudHost)
            .response(from: request, context: context)
        response.status = cloudHost.hostId == nil ? .accepted : .created
        return response
    }

    @Sendable
    func register(_ request: Request, context: AppRequestContext) async throws -> Response {
        let workspaceID = try Self.workspaceID(context)
        let token = try Self.bootstrapToken(request)
        let digest = Self.tokenDigest(token)
        let input = try await request.decode(as: RegisterWorkHostRequest.self, context: context)
        guard try WorkHostRoutes.validatedScope(input.scope) == "workspace",
              try WorkHostRoutes.validatedType(input.type) == "cloud"
        else {
            throw HTTPError(.badRequest, message: "cloud workd must register workspace-scoped type=cloud")
        }
        let displayName = try WorkHostRoutes.validatedDisplayName(input.displayName)
        let publicKey = try WorkHostRoutes.validatedPublicKey(input.publicKey)
        let capabilities = try WorkHostRoutes.validatedCapabilities(input.capabilities)
        let capabilitiesJSON = Self.jsonString(capabilities)

        let host = try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT id, requester_member_id, provider_sandbox_id IS NOT NULL
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND bootstrap_token_digest = \(digest)
                   AND bootstrap_consumed_at IS NULL
                   AND bootstrap_expires_at > clock_timestamp()
                   AND state = 'provisioning'
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.unauthorized, message: "invalid or expired cloud bootstrap token")
            }
            let (provisionID, ownerID, sandboxKnown) = try row.decode((UUID, UUID, Bool).self)
            let hostRows = try await conn.query(
                """
                INSERT INTO work_host
                  (workspace_id, scope, owner_member_id, type, display_name,
                   public_key, capabilities, last_seen_at)
                VALUES
                  (\(workspaceID), 'workspace', \(ownerID), 'cloud', \(displayName),
                   \(publicKey), \(capabilitiesJSON)::jsonb, clock_timestamp())
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard let hostID = try hostRows.first?.decode(UUID.self) else {
                throw HTTPError(.internalServerError, message: "cloud work host insert failed")
            }
            _ = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET host_id = \(hostID),
                       bootstrap_consumed_at = clock_timestamp(),
                       state = CASE WHEN \(sandboxKnown) THEN 'ready' ELSE 'provisioning' END,
                       updated_at = clock_timestamp()
                 WHERE id = \(provisionID)
                """,
                logger: db.logger
            )
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, detail)
                VALUES
                  (\(workspaceID), \(ownerID), \(ownerID),
                   'work.cloud.host.registered', 'work_host', \(hostID),
                   jsonb_build_object(
                     'schema', 'momo.work_cloud.host.registered.v1',
                     'provision_id', \(provisionID),
                     'type', 'cloud'
                   ))
                """,
                logger: db.logger
            )
            return try await WorkHostRoutes.loadHost(
                conn: conn, logger: db.logger, hostID: hostID
            )
        }

        var response = try WorkHostResponse(workHost: host)
            .response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func get(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let provisionID = try Self.parameterUUID("provision", context: context)
        let cloudHost: CloudHostDTO = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT id, host_id, state, provider, created_at
                  FROM work_cloud_host
                 WHERE id = \(provisionID)
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "momo Cloud 요청을 찾을 수 없습니다.")
            }
            return try Self.decodeCloudHost(row)
        }
        return try CloudHostResponse(cloudHost: cloudHost)
            .response(from: request, context: context)
    }

    @Sendable
    func pause(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await transition(
            action: .pause, request: request, context: context
        )
    }

    @Sendable
    func resume(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await transition(
            action: .resume, request: request, context: context
        )
    }

    @Sendable
    func destroy(_ request: Request, context: AppRequestContext) async throws -> Response {
        try await transition(
            action: .destroy, request: request, context: context
        )
    }

    private enum LifecycleAction: Equatable {
        case pause, resume, destroy
    }

    private func transition(
        action: LifecycleAction,
        request: Request,
        context: AppRequestContext
    ) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let hostID = try Self.parameterUUID("host", context: context)
        let readyConfig = try Self.readyConfig(config)
        let intent = try await beginLifecycleIntent(
            workspaceID: workspaceID,
            principal: principal,
            hostID: hostID,
            action: action
        )
        let provisioner = E2BProvisioner(httpClient: httpClient, config: readyConfig)
        do {
            switch action {
            case .pause: try await provisioner.pause(sandboxID: intent.sandboxID)
            case .resume: try await provisioner.resume(sandboxID: intent.sandboxID)
            case .destroy: try await provisioner.destroy(sandboxID: intent.sandboxID)
            }
        } catch {
            if action == .resume, Self.isMissingSandbox(error) {
                try await markResumeSandboxMissing(
                    workspaceID: workspaceID,
                    hostID: hostID,
                    operationID: intent.operationID,
                    principal: principal
                )
                throw HTTPError(
                    .gone,
                    message: "momo Cloud 샌드박스가 사라져 orphan 정리를 예약했습니다."
                )
            }
            throw Self.httpError(error)
        }

        let cloudHost = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            switch action {
            case .pause:
                let sessionID = try await CloudUsageLedger.pause(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, hostID: hostID
                )
                _ = try await conn.query(
                    """
                    UPDATE work_session
                       SET status = 'idle', idle_at = clock_timestamp()
                     WHERE workspace_id = \(workspaceID)
                       AND id = \(sessionID)
                       AND status = 'running'
                    """,
                    logger: db.logger
                )
            case .resume:
                let sessionID = try await CloudUsageLedger.resume(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, hostID: hostID
                )
                let sessionRows = try await conn.query(
                    """
                    UPDATE work_session
                       SET status = 'running', idle_at = NULL
                     WHERE workspace_id = \(workspaceID)
                       AND id = \(sessionID)
                       AND status = 'idle'
                    RETURNING id
                    """,
                    logger: db.logger
                ).collect()
                guard sessionRows.first != nil else {
                    throw HTTPError(.conflict, message: "work session state changed; reconciliation pending")
                }
                _ = try await conn.query(
                    """
                    INSERT INTO outbox
                      (workspace_id, kind, method, payload, partition_key)
                    SELECT ws.workspace_id, 'broadcast', 'publish',
                           jsonb_build_object(
                             'channel', 'ch:ws' || lower(ws.workspace_id::text)
                               || '.' || lower(ws.channel_id::text),
                             'data', jsonb_build_object(
                               'type', 'work.session.resumed-to-running',
                               'v', 1,
                               'ts', floor(
                                 extract(epoch FROM clock_timestamp()) * 1000
                               )::bigint,
                               'seq', root.seq,
                               'payload', jsonb_build_object(
                                 'session_id', lower(ws.id::text),
                                 'channel_id', lower(ws.channel_id::text),
                                 'root_message_id', lower(ws.root_message_id::text),
                                 'member_id', lower(ws.member_id::text),
                                 'host_id', lower(ws.host_id::text),
                                 'status', 'running',
                                 'resumed_at', floor(
                                   extract(epoch FROM clock_timestamp()) * 1000
                                 )::bigint
                               )
                             ),
                             'idempotency_key',
                               'cloud-resume:' || lower(\(intent.operationID)::text)
                           ),
                           ws.channel_id
                      FROM work_session ws
                      JOIN message root ON root.id = ws.root_message_id
                     WHERE ws.id = \(sessionID)
                    """,
                    logger: db.logger
                )
            case .destroy:
                let usageRows = try await conn.query(
                    """
                    SELECT 1
                      FROM work_host_usage
                     WHERE workspace_id = \(workspaceID)
                       AND host_id = \(hostID)
                       AND settled_at IS NULL
                    """,
                    logger: db.logger
                ).collect()
                guard usageRows.first == nil else {
                    throw HTTPError(
                        .conflict,
                        message: "실행 중인 세션을 먼저 종료한 뒤 momo Cloud 호스트를 삭제하세요."
                    )
                }
            }
            let nextState: String
            switch action {
            case .pause: nextState = "paused"
            case .resume: nextState = "running"
            case .destroy: nextState = "destroyed"
            }
            let updatedRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(nextState), updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND lifecycle_operation_id = \(intent.operationID)
                   AND state = \(intent.intentState)
                RETURNING id, host_id, state, provider, created_at
                """,
                logger: db.logger
            ).collect()
            guard let row = updatedRows.first else {
                throw HTTPError(.conflict, message: "momo Cloud 호스트 상태가 변경되었습니다.")
            }
            if action == .destroy {
                _ = try await conn.query(
                    """
                    UPDATE work_host
                       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
                     WHERE id = \(hostID)
                    """,
                    logger: db.logger
                )
            }
            let actionName: String
            switch action {
            case .pause: actionName = "paused"
            case .resume: actionName = "resumed"
            case .destroy: actionName = "destroyed"
            }
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, subject_member_id, action,
                   target_type, target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), \(principal.memberID),
                   \("work.cloud.\(actionName)"), 'work_host', \(hostID),
                   \(principal.tokenID),
                   jsonb_build_object(
                     'schema', \("momo.work_cloud.\(actionName).v1"),
                     'host_id', \(hostID)
                   ))
                """,
                logger: db.logger
            )
            return try Self.decodeCloudHost(row)
        }
        return try CloudHostResponse(cloudHost: cloudHost)
            .response(from: request, context: context)
    }

    private struct LifecycleIntent: Sendable {
        let sandboxID: String
        let operationID: UUID
        let intentState: String
    }

    private func beginLifecycleIntent(
        workspaceID: UUID,
        principal: AuthPrincipal,
        hostID: UUID,
        action: LifecycleAction
    ) async throws -> LifecycleIntent {
        try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            guard let role = try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            ) else {
                throw HTTPError(.forbidden, message: "active workspace membership required")
            }
            let rows = try await conn.query(
                """
                SELECT requester_member_id, provider_sandbox_id, state,
                       EXISTS (
                         SELECT 1
                           FROM work_host_usage u
                          WHERE u.workspace_id = work_cloud_host.workspace_id
                            AND u.host_id = work_cloud_host.host_id
                            AND u.settled_at IS NULL
                       ) AS has_open_usage
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "momo Cloud 호스트를 찾을 수 없습니다.")
            }
            let (requesterID, sandboxID, state, hasOpenUsage) =
                try row.decode((UUID, String?, String, Bool).self)
            guard requesterID == principal.memberID || role.isAdmin else {
                throw HTTPError(.forbidden, message: "momo Cloud 호스트 소유자 또는 관리자만 변경할 수 있습니다.")
            }
            let expectedState: String
            let intentState: String
            let operationKind: String
            switch action {
            case .pause:
                expectedState = "running"; intentState = "pausing"; operationKind = "pause"
            case .resume:
                expectedState = "paused"; intentState = "resuming"; operationKind = "resume"
            case .destroy:
                expectedState = "ready"; intentState = "destroy_pending"; operationKind = "destroy"
            }
            guard state == expectedState else {
                throw HTTPError(
                    .conflict,
                    message: "momo Cloud 호스트를 이 상태에서 변경할 수 없습니다. 현재 상태: \(state)"
                )
            }
            guard action != .destroy || !hasOpenUsage else {
                throw HTTPError(
                    .conflict,
                    message: "실행 중인 세션을 먼저 종료한 뒤 momo Cloud 호스트를 삭제하세요."
                )
            }
            guard let sandboxID else {
                throw HTTPError(.serviceUnavailable, message: "E2B 샌드박스 연결 정보가 준비되지 않았습니다.")
            }
            let operationID = UUID()
            let updatedRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(intentState),
                       lifecycle_operation_id = \(operationID),
                       lifecycle_operation_kind = \(operationKind),
                       lifecycle_operation_started_at = clock_timestamp(),
                       lifecycle_operation_version = lifecycle_operation_version + 1,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state = \(expectedState)
                RETURNING id
                """,
                logger: db.logger
            ).collect()
            guard updatedRows.first != nil else {
                throw HTTPError(.conflict, message: "momo Cloud 호스트 상태가 변경되었습니다.")
            }
            return LifecycleIntent(
                sandboxID: sandboxID,
                operationID: operationID,
                intentState: intentState
            )
        }
    }

    private func markResumeSandboxMissing(
        workspaceID: UUID,
        hostID: UUID,
        operationID: UUID,
        principal: AuthPrincipal
    ) async throws {
        try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            let usageRows = try await conn.query(
                """
                SELECT session_id
                  FROM work_host_usage
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND settled_at IS NULL
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            let sessionID = try usageRows.first?.decode(UUID.self)
            _ = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = 'destroyed', updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state = 'resuming'
                   AND lifecycle_operation_id = \(operationID)
                """,
                logger: db.logger
            )
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
            _ = try await conn.query(
                """
                INSERT INTO audit_log
                  (workspace_id, actor_member_id, action, target_type,
                   target_id, via_token_id, detail)
                VALUES
                  (\(workspaceID), \(principal.memberID), 'work.cloud.resume_failed',
                   'work_host', \(hostID), \(principal.tokenID),
                   jsonb_build_object(
                     'schema', 'momo.work_cloud.resume_failed.v1',
                     'host_id', \(hostID),
                     'session_id', \(sessionID),
                     'reason', 'sandbox_missing',
                     'orphan_transition', 'host_offline_sweep'
                   ))
                """,
                logger: db.logger
            )
        }
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

    static func readyConfig(_ config: CloudProvisionerConfig) throws
        -> ReadyCloudProvisionerConfig
    {
        do { return try config.requireReady() }
        catch CloudProvisionerError.missingAPIKey {
            throw HTTPError(
                .serviceUnavailable,
                message: "momo Cloud를 사용할 수 없습니다. 인스턴스 운영자에게 E2B 설정을 요청하세요."
            )
        } catch {
            throw HTTPError(
                .serviceUnavailable,
                message: "momo Cloud 프로비저너 설정이 완전하지 않습니다. 인스턴스 운영자에게 문의하세요."
            )
        }
    }

    static func httpError(_ error: Error) -> HTTPError {
        if case CloudProvisionerError.upstreamStatus(let status) = error, status == 429 {
            return HTTPError(
                .tooManyRequests,
                message: "E2B 동시 실행 한도에 도달했습니다. 잠시 후 다시 시도하세요."
            )
        }
        return HTTPError(
            .serviceUnavailable,
            message: "momo Cloud 호스트를 준비하지 못했습니다. 잠시 후 다시 시도하세요."
        )
    }

    private static func isMissingSandbox(_ error: Error) -> Bool {
        guard case CloudProvisionerError.upstreamStatus(let status) = error else {
            return false
        }
        return status == 404 || status == 410
    }

    static func tokenDigest(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func randomToken() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Stable across a lost create response without persisting raw bootstrap
    /// material. The E2B operator key remains process-only and the provider
    /// create call uses the same provision UUID as its idempotency key.
    static func bootstrapToken(provisionID: UUID, apiKey: String) -> String {
        let key = SymmetricKey(data: Data(apiKey.utf8))
        let payload = Data(
            "momo.cloud.bootstrap.v1:\(provisionID.uuidString.lowercased())".utf8
        )
        return Data(HMAC<SHA256>.authenticationCode(for: payload, using: key))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func cloudHostResponse(
        request: Request,
        context: AppRequestContext,
        workspaceID: UUID,
        provisionID: UUID
    ) async throws -> Response {
        let dto: CloudHostDTO = try await db.withTenantConnection(
            workspaceID: workspaceID
        ) { conn in
            let rows = try await conn.query(
                """
                SELECT id, host_id, state, provider, created_at
                  FROM work_cloud_host
                 WHERE id = \(provisionID)
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "momo Cloud 요청을 찾을 수 없습니다.")
            }
            return try Self.decodeCloudHost(row)
        }
        var response = try CloudHostResponse(cloudHost: dto)
            .response(from: request, context: context)
        response.status = dto.hostId == nil ? .accepted : .created
        return response
    }

    private static func bootstrapToken(_ request: Request) throws -> String {
        guard let header = request.headers[.authorization],
              header.hasPrefix("MomoBootstrap ")
        else {
            throw HTTPError(.unauthorized, message: "cloud bootstrap authorization required")
        }
        let token = String(header.dropFirst("MomoBootstrap ".count))
        guard token.count >= 40, token.count <= 128 else {
            throw HTTPError(.unauthorized, message: "invalid cloud bootstrap authorization")
        }
        return token
    }

    private static func requireHuman(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "momo Cloud management requires a human member")
        }
        return principal
    }

    private static func workspaceID(_ context: AppRequestContext) throws -> UUID {
        try parameterUUID("ws", context: context)
    }

    private static func parameterUUID(
        _ name: String,
        context: AppRequestContext
    ) throws -> UUID {
        let raw = try context.parameters.require(name)
        guard let value = UUID(uuidString: raw) else {
            throw HTTPError(.badRequest, message: "invalid \(name) id")
        }
        return value
    }

    private static func decodeCloudHost(_ row: PostgresRow) throws -> CloudHostDTO {
        let decoded = try row.decode((UUID, UUID?, String, String, Date).self)
        return CloudHostDTO(
            provisionId: decoded.0.uuidString,
            hostId: decoded.1?.uuidString,
            state: decoded.2,
            provider: decoded.3,
            createdAtMs: Int64(decoded.4.timeIntervalSince1970 * 1_000)
        )
    }

    private static func jsonString(_ object: Any) -> String {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8)
        else { return "{}" }
        return string
    }
}
