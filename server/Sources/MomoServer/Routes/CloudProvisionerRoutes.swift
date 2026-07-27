import AsyncHTTPClient
import Crypto
import Foundation
import Hummingbird
import Logging
import PostgresNIO

struct CreateCloudHostRequest: Decodable {
    let displayName: String
    let confirmPaidCloud: Bool
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
        let token = Self.randomToken()
        let digest = Self.tokenDigest(token)
        let expiresAt = Date().addingTimeInterval(Self.bootstrapTTLSeconds)

        let provisionID: UUID = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn, logger: db.logger, principal: principal
            )
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
            _ = try await conn.query(
                """
                INSERT INTO work_cloud_host
                  (id, workspace_id, requester_member_id, bootstrap_token_digest,
                   bootstrap_expires_at, unit_rate_micro_usd_second)
                VALUES
                  (\(provisionID), \(workspaceID), \(principal.memberID), \(digest),
                   \(expiresAt), \(readyConfig.unitRateMicroUSDSecond))
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
            return provisionID
        }

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
            try? await markFailed(workspaceID: workspaceID, provisionID: provisionID)
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
        let expectedState: String
        switch action {
        case .pause: expectedState = "running"
        case .resume: expectedState = "paused"
        case .destroy: expectedState = "ready"
        }
        let sandboxID = try await lifecyclePreflight(
            workspaceID: workspaceID,
            principal: principal,
            hostID: hostID,
            expectedState: expectedState,
            requireNoOpenUsage: action == .destroy
        )
        let provisioner = E2BProvisioner(httpClient: httpClient, config: readyConfig)
        do {
            switch action {
            case .pause: try await provisioner.pause(sandboxID: sandboxID)
            case .resume: try await provisioner.resume(sandboxID: sandboxID)
            case .destroy: try await provisioner.destroy(sandboxID: sandboxID)
            }
        } catch {
            throw Self.httpError(error)
        }

        let cloudHost = try await withTenantTransactionUnwrapped(
            workspaceID: workspaceID
        ) { conn in
            switch action {
            case .pause:
                _ = try await CloudUsageLedger.pause(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, hostID: hostID
                )
            case .resume:
                _ = try await CloudUsageLedger.resume(
                    conn: conn, logger: db.logger, workspaceID: workspaceID, hostID: hostID
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
            let rows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(nextState), updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state = \(expectedState)
                RETURNING id, host_id, state, provider, created_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
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

    private func lifecyclePreflight(
        workspaceID: UUID,
        principal: AuthPrincipal,
        hostID: UUID,
        expectedState: String,
        requireNoOpenUsage: Bool
    ) async throws -> String {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
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
            guard state == expectedState else {
                throw HTTPError(
                    .conflict,
                    message: "momo Cloud 호스트를 이 상태에서 변경할 수 없습니다. 현재 상태: \(state)"
                )
            }
            guard !requireNoOpenUsage || !hasOpenUsage else {
                throw HTTPError(
                    .conflict,
                    message: "실행 중인 세션을 먼저 종료한 뒤 momo Cloud 호스트를 삭제하세요."
                )
            }
            guard let sandboxID else {
                throw HTTPError(.serviceUnavailable, message: "E2B 샌드박스 연결 정보가 준비되지 않았습니다.")
            }
            return sandboxID
        }
    }

    private func markFailed(workspaceID: UUID, provisionID: UUID) async throws {
        try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            _ = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = 'failed',
                       bootstrap_expires_at = clock_timestamp(),
                       updated_at = clock_timestamp()
                 WHERE id = \(provisionID)
                   AND state = 'provisioning'
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
