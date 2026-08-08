import AsyncHTTPClient
import CloudProviderKit
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

/// ADR-0142 D1 — a workspace operator enrolls a host they already own.
/// `scope` is accepted only so a personal request can be refused by name
/// rather than silently promoted to a workspace host.
struct EnrollBYOCHostRequest: Decodable {
    let displayName: String
    let scope: String?
    let idempotencyRef: String
}

struct BYOCEnrollmentDTO: ResponseEncodable, Codable, Sendable, Equatable {
    let provisionId: String
    let provider: String
    let state: String
    /// Shown exactly once. Only its SHA-256 digest reaches PostgreSQL.
    let bootstrapToken: String
    let bootstrapExpiresAtMs: Int64
    let registerUrl: String
}

struct BYOCEnrollmentResponse: ResponseEncodable {
    let enrollment: BYOCEnrollmentDTO
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

/// ADR-0136 + ADR-0142 server-side T3 provisioner.
///
/// Two acquisition paths, one lifecycle. `create` is the managed path: the
/// configured provider adapter receives a short-lived bootstrap token and
/// starts the operator-owned workd image. `enroll` is the BYOC path: the
/// workspace operator gets that same one-shot token and installs workd on
/// their own machine. Both end at the same `register`, where workd creates its
/// own Ed25519 key and consumes the token. Provider credentials stay
/// process-only configuration and never enter a workspace row or response.
struct CloudProvisionerRoutes: Sendable {
    static let bootstrapTTLSeconds: TimeInterval = 15 * 60

    let db: Database
    let httpClient: HTTPClient
    let config: CloudProvisionerConfig

    func addProtected(to group: RouterGroup<AppRequestContext>) {
        group.post("/v1/workspaces/:ws/work-hosts/cloud", use: create)
        group.post("/v1/workspaces/:ws/work-hosts/byoc/enrollments", use: enroll)
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
                message: "oort Cloud는 유료 실행입니다. 명시적으로 동의한 뒤 다시 요청하세요."
            )
        }
        let displayName = try WorkHostRoutes.validatedDisplayName(input.displayName)
        let readyConfig = try Self.readyConfig(config)
        // ADR-0142 D2: policy asks the capability, never the provider name. A
        // degenerate adapter (BYOC) has no create at all, so this instance
        // sends the operator to the enrollment path instead of pretending.
        guard readyConfig.defaultCapabilities.supports(.create) else {
            throw HTTPError(
                .conflict,
                message: "이 인스턴스의 T3 provider는 호스트 생성을 지원하지 않습니다. BYOC 등록을 사용하세요."
            )
        }
        let providerID = readyConfig.defaultProviderID
        guard let bootstrapSecret = readyConfig.bootstrapSecret(for: providerID) else {
            throw HTTPError(
                .serviceUnavailable,
                message: "oort Cloud 프로비저너 설정이 완전하지 않습니다. 인스턴스 운영자에게 문의하세요."
            )
        }
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
            // A row lock cannot serialize a key which does not exist yet.
            // Lock the normalized tenant+client key before the first lookup so
            // concurrent retries cannot both observe absence and race the
            // partial unique index into a 500.
            _ = try await conn.query(
                """
                SELECT pg_advisory_xact_lock(
                  hashtextextended(
                    lower(\(workspaceID)::text) || ':' || lower(\(createKey)::text),
                    0
                  )
                )
                """,
                logger: db.logger
            ).collect()
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
                throw HTTPError(.internalServerError, message: "oort Cloud 요청 ID를 만들지 못했습니다.")
            }
            let token = Self.bootstrapToken(
                provisionID: provisionID,
                secret: bootstrapSecret
            )
            let digest = Self.tokenDigest(token)
            // Migration 054 dropped the provider default: the adapter that owns
            // a host is stated at insert time, never inferred later.
            _ = try await conn.query(
                """
                INSERT INTO work_cloud_host
                  (id, workspace_id, requester_member_id, provider,
                   bootstrap_token_digest,
                   bootstrap_expires_at, unit_rate_micro_usd_second,
                   create_idempotency_key, requested_display_name)
                VALUES
                  (\(provisionID), \(workspaceID), \(principal.memberID),
                   \(providerID), \(digest),
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
                     'provider', \(providerID),
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
            secret: bootstrapSecret
        )

        let instance: CloudInstanceRef
        do {
            instance = try await readyConfig
                .adapter(for: providerID, httpClient: httpClient)
                .create(
                    spec: CloudInstanceSpec(
                        provisionID: provisionID,
                        workspaceID: workspaceID,
                        displayName: displayName,
                        registrationToken: token,
                        serverURL: readyConfig.publicServerURL
                    ),
                    idempotencyKey: provisionID.uuidString.lowercased()
                )
        } catch {
            // A timeout/invalid response is ambiguous: the provider may have
            // committed a paid instance. Keep the durable provisioning intent
            // so the same idempotency key can replay and converge it.
            throw Self.httpError(error)
        }

        let cloudHost: CloudHostDTO
        do {
            cloudHost = try await withTenantLifecycleTransactionUnwrapped(
                workspaceID: workspaceID,
                cloudHostID: provisionID
            ) { conn in
                let rows = try await conn.query(
                    """
                    UPDATE work_cloud_host
                       SET provider_sandbox_id = \(instance.instanceID),
                           state = CASE WHEN host_id IS NULL THEN 'provisioning' ELSE 'ready' END,
                           updated_at = clock_timestamp()
                     WHERE id = \(provisionID)
                       AND state = 'provisioning'
                    RETURNING id, host_id, state, provider, created_at
                    """,
                    logger: db.logger
                ).collect()
                guard let row = rows.first else {
                    throw HTTPError(.conflict, message: "oort Cloud 요청 상태가 변경되었습니다.")
                }
                return try Self.decodeCloudHost(row)
            }
        } catch {
            try? await readyConfig
                .adapter(for: providerID, httpClient: httpClient)
                .destroy(
                    ref: instance,
                    idempotencyKey: "cleanup-\(provisionID.uuidString.lowercased())"
                )
            throw error
        }

        var response = try CloudHostResponse(cloudHost: cloudHost)
            .response(from: request, context: context)
        response.status = cloudHost.hostId == nil ? .accepted : .created
        return response
    }

    /// ADR-0142 D1 — BYOC enrollment.
    ///
    /// Same lifecycle, different acquisition: oort issues the one-shot token
    /// and the operator installs `momo-workd` wherever they like. There is no
    /// provider call here at all, which is the whole point — oort never gained
    /// the right to boot or kill that machine.
    @Sendable
    func enroll(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let input = try await request.decode(as: EnrollBYOCHostRequest.self, context: context)
        // ADR-0142 D1: workspace-shared only. The schema does not block a
        // personal host; this REST does, by name, so a personal request is
        // refused instead of quietly becoming a workspace-wide host.
        if let scope = input.scope, scope != "workspace" {
            throw HTTPError(
                .badRequest,
                message: "BYOC 등록은 워크스페이스 공용만 지원합니다. 개인 호스트는 아직 열려 있지 않습니다."
            )
        }
        let displayName = try WorkHostRoutes.validatedDisplayName(input.displayName)
        let readyConfig = try Self.readyConfig(config)
        let capabilities = try Self.byocCapabilities(readyConfig)
        guard let enrollKey = UUID(uuidString: input.idempotencyRef) else {
            throw HTTPError(.badRequest, message: "idempotencyRef must be a UUID")
        }
        let expiresAt = Date().addingTimeInterval(Self.bootstrapTTLSeconds)
        let token = Self.randomToken()
        let digest = Self.tokenDigest(token)

        let enrollment: (provisionID: UUID, expiresAt: Date, replayed: Bool) =
            try await withTenantTransactionUnwrapped(workspaceID: workspaceID) { conn in
            try await InviteRoutes.requireWorkspaceMember(
                conn: conn, logger: db.logger, principal: principal
            )
            guard let role = try await WorkspaceAuthorization.activeRole(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            ), role.isAdmin else {
                throw HTTPError(
                    .forbidden,
                    message: "BYOC 호스트 등록은 워크스페이스 관리자만 할 수 있습니다."
                )
            }
            // Same serialization the managed create uses: a row lock cannot
            // order a key which does not exist yet.
            _ = try await conn.query(
                """
                SELECT pg_advisory_xact_lock(
                  hashtextextended(
                    lower(\(workspaceID)::text) || ':' || lower(\(enrollKey)::text),
                    0
                  )
                )
                """,
                logger: db.logger
            ).collect()
            let existingRows = try await conn.query(
                """
                SELECT id, bootstrap_expires_at
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND create_idempotency_key = \(enrollKey)
                 FOR UPDATE
                """,
                logger: db.logger
            ).collect()
            if let existingRow = existingRows.first {
                let (existingID, existingExpiry) = try existingRow.decode((UUID, Date).self)
                return (existingID, existingExpiry, true)
            }
            try await CloudUsageLedger.reserveProvisioningSlot(
                conn: conn,
                logger: db.logger,
                workspaceID: workspaceID,
                memberID: principal.memberID
            )
            let idRows = try await conn.query("SELECT uuidv7()", logger: db.logger).collect()
            guard let provisionID = try idRows.first?.decode(UUID.self) else {
                throw HTTPError(.internalServerError, message: "BYOC 등록 ID를 만들지 못했습니다.")
            }
            // The degenerate adapter's instance handle is the enrollment
            // itself: there is no provider-side object to name.
            let instanceID = "byoc-" + provisionID.uuidString.lowercased()
            _ = try await conn.query(
                """
                INSERT INTO work_cloud_host
                  (id, workspace_id, requester_member_id, provider,
                   provider_sandbox_id, bootstrap_token_digest,
                   bootstrap_expires_at, unit_rate_micro_usd_second,
                   create_idempotency_key, requested_display_name)
                VALUES
                  (\(provisionID), \(workspaceID), \(principal.memberID),
                   \(capabilities.providerID), \(instanceID), \(digest),
                   \(expiresAt), \(readyConfig.unitRateMicroUSDSecond),
                   \(enrollKey), \(displayName))
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
                   'work.cloud.byoc.enrolled', 'work_cloud_host', \(provisionID),
                   \(principal.tokenID),
                   jsonb_build_object(
                     'schema', 'momo.work_cloud.byoc.enrolled.v1',
                     'provider', \(capabilities.providerID),
                     'scope', 'workspace'
                   ))
                """,
                logger: db.logger
            )
            return (provisionID, expiresAt, false)
        }

        // A replayed idempotencyRef cannot re-reveal a token oort never kept.
        guard !enrollment.replayed else {
            throw HTTPError(
                .conflict,
                message: "이 idempotencyRef의 등록 토큰은 이미 발급됐습니다. 새 ref로 다시 요청하세요."
            )
        }
        var response = try BYOCEnrollmentResponse(
            enrollment: BYOCEnrollmentDTO(
                provisionId: enrollment.provisionID.uuidString,
                provider: capabilities.providerID,
                state: "provisioning",
                bootstrapToken: token,
                bootstrapExpiresAtMs: Int64(enrollment.expiresAt.timeIntervalSince1970 * 1_000),
                registerUrl: readyConfig.publicServerURL
                    + "/v1/workspaces/" + workspaceID.uuidString.lowercased()
                    + "/work-hosts/cloud/register"
            )
        ).response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func register(_ request: Request, context: AppRequestContext) async throws -> Response {
        try Self.requireEnabled(config)
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
        let expectedProvisionID = try await t3CloudHostID(
            workspaceID: workspaceID,
            bootstrapTokenDigest: digest
        )

        let host = try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: expectedProvisionID
        ) { conn in
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
            guard provisionID == expectedProvisionID else {
                throw HTTPError(
                    .conflict,
                    message: "oort Cloud registration lifecycle changed; retry"
                )
            }
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
        try Self.requireEnabled(config)
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
                throw HTTPError(.notFound, message: "oort Cloud 요청을 찾을 수 없습니다.")
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
        try Self.requireEnabled(config)
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let hostID = try Self.parameterUUID("host", context: context)
        let readyConfig = try Self.readyConfig(config)
        let intent = try await beginLifecycleIntent(
            workspaceID: workspaceID,
            principal: principal,
            hostID: hostID,
            action: action,
            readyConfig: readyConfig
        )
        // The adapter is chosen by the host's own registry key, not by whatever
        // this process provisions new hosts with today (ADR-0142 D2).
        let adapter = try readyConfig.adapter(
            for: intent.providerID, httpClient: httpClient
        )
        do {
            let key = intent.operationID.uuidString.lowercased()
            switch action {
            case .pause: try await adapter.pause(ref: intent.ref, idempotencyKey: key)
            case .resume: try await adapter.resume(ref: intent.ref, idempotencyKey: key)
            case .destroy: try await adapter.destroy(ref: intent.ref, idempotencyKey: key)
            }
        } catch {
            if action == .resume, Self.isMissingSandbox(error) {
                try await markResumeSandboxMissing(
                    workspaceID: workspaceID,
                    cloudHostID: intent.cloudHostID,
                    hostID: hostID,
                    operationID: intent.operationID,
                    version: intent.version,
                    providerID: intent.providerID,
                    principal: principal
                )
                throw HTTPError(
                    .gone,
                    message: "oort Cloud 샌드박스가 사라져 orphan 정리를 예약했습니다."
                )
            }
            throw Self.httpError(error)
        }

        let cloudHost = try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: intent.cloudHostID
        ) { conn in
            // ADR-0140 D4 ③. The provider answered a question about *this*
            // operation; between asking and answering, a sweep, the reconciler,
            // or another caller may have replaced it. Applying the answer then
            // is the second-review defect verbatim, so the answer is discarded
            // instead — the row lock this takes is held to commit, which is why
            // the writes below can key on identity alone.
            guard try await T3LifecycleIntent.isCurrent(
                conn: conn,
                logger: db.logger,
                cloudHostID: intent.cloudHostID,
                operationID: intent.operationID,
                version: intent.version,
                expectedState: intent.intentState
            ) else {
                throw T3LifecycleIntent.staleResponse
            }
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
                        message: "실행 중인 세션을 먼저 종료한 뒤 oort Cloud 호스트를 삭제하세요."
                    )
                }
            }
            let nextState: String
            switch action {
            case .pause: nextState = "paused"
            case .resume: nextState = "running"
            case .destroy: nextState = "destroyed"
            }
            // Keyed on identity: the revalidation above already proved this is
            // the current operation and still holds the row lock.
            let updatedRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(nextState),
                       lifecycle_operation_next_attempt_at = NULL,
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND id = \(intent.cloudHostID)
                RETURNING id, host_id, state, provider, created_at
                """,
                logger: db.logger
            ).collect()
            guard let row = updatedRows.first else {
                throw HTTPError(.conflict, message: "oort Cloud 호스트 상태가 변경되었습니다.")
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
        let cloudHostID: UUID
        let providerID: String
        let instanceID: String
        let operationID: UUID
        /// ADR-0140 D4 ③: the version this response will be revalidated
        /// against. Anything that touches the operation while the provider call
        /// is in flight moves it, and the response is then discarded.
        let version: Int64
        let intentState: String

        var ref: CloudInstanceRef {
            CloudInstanceRef(providerID: providerID, instanceID: instanceID)
        }
    }

    private func beginLifecycleIntent(
        workspaceID: UUID,
        principal: AuthPrincipal,
        hostID: UUID,
        action: LifecycleAction,
        readyConfig: ReadyCloudProvisionerConfig
    ) async throws -> LifecycleIntent {
        guard let cloudHostID = try await t3CloudHostID(
            workspaceID: workspaceID,
            hostID: hostID
        ) else {
            throw HTTPError(.notFound, message: "oort Cloud 호스트를 찾을 수 없습니다.")
        }
        return try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: cloudHostID
        ) { conn in
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
                SELECT id, requester_member_id, provider_sandbox_id, state, provider,
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
                throw HTTPError(.notFound, message: "oort Cloud 호스트를 찾을 수 없습니다.")
            }
            let (lockedCloudHostID, requesterID, sandboxID, state, rowProviderID,
                 hasOpenUsage) =
                try row.decode((UUID, UUID, String?, String, String, Bool).self)
            guard lockedCloudHostID == cloudHostID else {
                throw HTTPError(
                    .conflict,
                    message: "oort Cloud host lifecycle changed; retry"
                )
            }
            guard requesterID == principal.memberID || role.isAdmin else {
                throw HTTPError(.forbidden, message: "oort Cloud 호스트 소유자 또는 관리자만 변경할 수 있습니다.")
            }
            // Refuse rather than route a host to the wrong substrate: an
            // adapter that does not know this instance would answer "missing"
            // and terminally settle a live paid session.
            let rowCapabilities: CloudProviderCapabilities
            do {
                rowCapabilities = try readyConfig
                    .adapter(for: rowProviderID, httpClient: httpClient)
                    .capabilities
            } catch {
                throw HTTPError(
                    .serviceUnavailable,
                    message: "이 호스트의 provider 어댑터가 이 인스턴스에 설치돼 있지 않습니다."
                )
            }
            if action != .destroy, !rowCapabilities.supportsPause {
                throw HTTPError(
                    .conflict,
                    message: "이 호스트의 provider는 일시정지/재개를 지원하지 않습니다."
                )
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
                    message: "oort Cloud 호스트를 이 상태에서 변경할 수 없습니다. 현재 상태: \(state)"
                )
            }
            guard action != .destroy || !hasOpenUsage else {
                throw HTTPError(
                    .conflict,
                    message: "실행 중인 세션을 먼저 종료한 뒤 oort Cloud 호스트를 삭제하세요."
                )
            }
            guard let sandboxID else {
                throw HTTPError(
                    .serviceUnavailable,
                    message: "oort Cloud 인스턴스 연결 정보가 준비되지 않았습니다."
                )
            }
            let operationID = UUID()
            // ADR-0140 D4 ①. The deadline is committed with the intent, not
            // derived later: `*ing` without a bound is the permanent deadlock
            // this stage exists to remove, and migration 057 refuses the row
            // outright if a future writer omits it.
            let updatedRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(intentState),
                       lifecycle_operation_id = \(operationID),
                       lifecycle_operation_kind = \(operationKind),
                       lifecycle_operation_started_at = clock_timestamp(),
                       lifecycle_operation_version = lifecycle_operation_version + 1,
                       lifecycle_operation_attempts = 0,
                       lifecycle_operation_next_attempt_at = NULL,
                       lifecycle_operation_deadline_at =
                         clock_timestamp()
                         + t3_lifecycle_default_deadline(\(operationKind)),
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state = \(expectedState)
                RETURNING id, lifecycle_operation_version
                """,
                logger: db.logger
            ).collect()
            guard let intentRow = updatedRows.first else {
                throw HTTPError(.conflict, message: "oort Cloud 호스트 상태가 변경되었습니다.")
            }
            let version = try intentRow.decode((UUID, Int64).self).1
            return LifecycleIntent(
                cloudHostID: cloudHostID,
                providerID: rowProviderID,
                instanceID: sandboxID,
                operationID: operationID,
                version: version,
                intentState: intentState
            )
        }
    }

    private func markResumeSandboxMissing(
        workspaceID: UUID,
        cloudHostID: UUID,
        hostID: UUID,
        operationID: UUID,
        version: Int64,
        providerID: String,
        principal: AuthPrincipal
    ) async throws {
        try await withTenantLifecycleTransactionUnwrapped(
            workspaceID: workspaceID,
            cloudHostID: cloudHostID,
            lockWorkspaceCredit: true
        ) { conn in
            // A terminal settlement is the least reversible thing T3 does, so
            // it is the last place a superseded response may be applied.
            guard try await T3LifecycleIntent.isCurrent(
                conn: conn,
                logger: db.logger,
                cloudHostID: cloudHostID,
                operationID: operationID,
                version: version,
                expectedState: "resuming"
            ) else {
                throw T3LifecycleIntent.staleResponse
            }
            let usageRows = try await conn.query(
                """
                SELECT session_id
                  FROM work_host_usage
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND settled_at IS NULL
                """,
                logger: db.logger
            ).collect()
            let sessionID = try usageRows.first?.decode(UUID.self)
            if let sessionID {
                try await CloudUsageLedger.terminate(
                    conn: conn,
                    logger: db.logger,
                    workspaceID: workspaceID,
                    sessionID: sessionID,
                    reason: .providerMissing
                )
            } else {
                _ = try await conn.query(
                    """
                    UPDATE work_cloud_host
                       SET state = 'destroy_pending',
                           lifecycle_operation_kind = 'destroy',
                           lifecycle_operation_version =
                             lifecycle_operation_version + 1,
                           updated_at = clock_timestamp()
                     WHERE workspace_id = \(workspaceID)
                       AND host_id = \(hostID)
                       AND state = 'resuming'
                       AND lifecycle_operation_id = \(operationID)
                    """,
                    logger: db.logger
                )
            }
            _ = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = 'destroyed', updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID)
                   AND host_id = \(hostID)
                   AND state = 'destroy_pending'
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
                     'provider', \(providerID),
                     'reason', 'sandbox_missing',
                     'orphan_transition', 'host_offline_sweep'
                   ))
                """,
                logger: db.logger
            )
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

    private func t3CloudHostID(
        workspaceID: UUID,
        bootstrapTokenDigest: String
    ) async throws -> UUID? {
        try await db.withTenantConnection(workspaceID: workspaceID) { conn in
            let rows = try await conn.query(
                """
                SELECT id
                  FROM work_cloud_host
                 WHERE workspace_id = \(workspaceID)
                   AND bootstrap_token_digest = \(bootstrapTokenDigest)
                   AND bootstrap_consumed_at IS NULL
                   AND bootstrap_expires_at > clock_timestamp()
                   AND state = 'provisioning'
                """,
                logger: db.logger
            ).collect()
            return try rows.first?.decode(UUID.self)
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

    private func withTenantLifecycleTransactionUnwrapped<Result: Sendable>(
        workspaceID: UUID,
        cloudHostID: UUID?,
        lockWorkspaceCredit: Bool = false,
        _ body: @Sendable (PostgresConnection) async throws -> Result
    ) async throws -> Result {
        do {
            if let cloudHostID {
                return try await db.withTenantT3LifecycleTransaction(
                    workspaceID: workspaceID,
                    cloudHostID: cloudHostID,
                    lockWorkspaceCredit: lockWorkspaceCredit,
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

    static func readyConfig(_ config: CloudProvisionerConfig) throws
        -> ReadyCloudProvisionerConfig
    {
        do { return try config.requireReady() }
        catch CloudProvisionerConfigError.disabled {
            throw disabledError()
        }
        catch CloudProvisionerConfigError.missingEndpoint {
            throw HTTPError(
                .serviceUnavailable,
                message: "oort Cloud를 사용할 수 없습니다. 인스턴스 운영자에게 provider 설정을 요청하세요."
            )
        }
        catch CloudProvisionerConfigError.unknownProvider {
            throw HTTPError(
                .serviceUnavailable,
                message: "설정된 T3 provider가 어댑터 레지스트리에 없습니다. 인스턴스 운영자에게 문의하세요."
            )
        } catch {
            throw HTTPError(
                .serviceUnavailable,
                message: "oort Cloud 프로비저너 설정이 완전하지 않습니다. 인스턴스 운영자에게 문의하세요."
            )
        }
    }

    static func byocCapabilities(
        _ readyConfig: ReadyCloudProvisionerConfig
    ) throws -> CloudProviderCapabilities {
        do {
            return try readyConfig.capabilities(for: CloudProviderRegistry.byocProviderID)
        } catch {
            throw HTTPError(
                .serviceUnavailable,
                message: "BYOC 어댑터가 이 인스턴스에 설치돼 있지 않습니다."
            )
        }
    }

    static func requireEnabled(_ config: CloudProvisionerConfig) throws {
        guard config.enabled else { throw disabledError() }
    }

    static func disabledError() -> HTTPError {
        HTTPError(
            .serviceUnavailable,
            message: "oort Cloud(T3)는 기본 비활성입니다. 재설계 진행 중(#888)입니다."
        )
    }

    static func httpError(_ error: Error) -> HTTPError {
        if case CloudProvisionerError.upstreamStatus(let status) = error, status == 429 {
            return HTTPError(
                .tooManyRequests,
                message: "provider 동시 실행 한도에 도달했습니다. 잠시 후 다시 시도하세요."
            )
        }
        if case CloudProvisionerError.unsupported(let operation, let providerID) = error {
            return HTTPError(
                .conflict,
                message: "이 호스트의 provider(\(providerID))는 \(operation.rawValue) 연산을 지원하지 않습니다."
            )
        }
        return HTTPError(
            .serviceUnavailable,
            message: "oort Cloud 호스트를 준비하지 못했습니다. 잠시 후 다시 시도하세요."
        )
    }

    /// The provider stated the instance is gone. `.unknown`/transport failures
    /// never reach here — settling a paid session on an unanswered question is
    /// exactly the silent failure ADR-0142 D3.1 forbids.
    static func isMissingSandbox(_ error: Error) -> Bool {
        (error as? CloudProvisionerError) == .instanceMissing
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
    /// material. The provider operator key remains process-only and the create
    /// call uses the same provision UUID as its idempotency key.
    static func bootstrapToken(provisionID: UUID, secret: String) -> String {
        let key = SymmetricKey(data: Data(secret.utf8))
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
                throw HTTPError(.notFound, message: "oort Cloud 요청을 찾을 수 없습니다.")
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
            throw HTTPError(.forbidden, message: "oort Cloud management requires a human member")
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
