import Foundation
import Hummingbird
import Logging
import OutboundHTTPPolicy
import PostgresNIO

private enum EventSubscriptionKind: String, CaseIterable, Sendable {
    case mention
    case approvalRequest = "approval_request"
    case workStatusChanged = "work.status_changed"
}

private struct CreateEventSubscriptionRequest: Decodable, Sendable {
    let url: String
    let eventKinds: [String]
    let enabled: Bool?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case url, eventKinds, enabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let dynamic = try decoder.container(keyedBy: DynamicCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        guard dynamic.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "unknown field")
            )
        }
        url = try container.decode(String.self, forKey: .url)
        eventKinds = try container.decode([String].self, forKey: .eventKinds)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
    }
}

private struct UpdateEventSubscriptionRequest: Decodable, Sendable {
    let url: String?
    let eventKinds: [String]?
    let enabled: Bool?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case url, eventKinds, enabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let dynamic = try decoder.container(keyedBy: DynamicCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.rawValue))
        guard dynamic.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "unknown field")
            )
        }
        url = try container.decodeIfPresent(String.self, forKey: .url)
        eventKinds = try container.decodeIfPresent([String].self, forKey: .eventKinds)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled)
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

struct EventSubscriptionDTO: Codable, ResponseEncodable, Sendable, Equatable {
    let id: String
    let workspaceId: String
    let url: String
    let eventKinds: [String]
    let enabled: Bool
    let deliveryFailureCount: Int
    let disabledAtMs: Int64?
    let disabledReason: String?
    let createdBy: String
    let updatedBy: String
    let createdAtMs: Int64
    let updatedAtMs: Int64
}

private struct EventSubscriptionsResponse: ResponseEncodable {
    let eventSubscriptions: [EventSubscriptionDTO]
}

private struct EventSubscriptionResponse: ResponseEncodable {
    let eventSubscription: EventSubscriptionDTO
}

private struct CreatedEventSubscriptionResponse: ResponseEncodable {
    let eventSubscription: EventSubscriptionDTO
    /// Returned only once by create. It is never selected from or stored in PG.
    let secret: String
    let signatureVersion = "v1"
    let algorithm = "HMAC-SHA256"
}

protocol EventSubscriptionURLValidating: Sendable {
    func validate(_ rawURL: String) async throws -> URL
}

struct SystemEventSubscriptionURLValidator: EventSubscriptionURLValidating {
    let resolver: SystemAgentCardHostResolver
    let allowDevelopmentHTTP: Bool

    func validate(_ rawURL: String) async throws -> URL {
        let value = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf8.count <= 2_048, let parsed = URL(string: value) else {
            throw OutboundURLPolicyError.invalidURL
        }
        let url = try OutboundURLPolicy.validatedURL(
            parsed, allowDevelopmentHTTP: allowDevelopmentHTTP
        )
        _ = try await OutboundURLPolicy.validatedResolvedAddresses(
            for: url, resolver: resolver
        )
        return url
    }
}

struct EventSubscriptionRoutes: Sendable {
    let db: Database
    let signingMasterKey: String
    let urlValidator: any EventSubscriptionURLValidating

    func add(to group: RouterGroup<AppRequestContext>) {
        group.get("/v1/workspaces/:ws/event-subscriptions", use: list)
        group.post("/v1/workspaces/:ws/event-subscriptions", use: create)
        group.put("/v1/workspaces/:ws/event-subscriptions/:subscription", use: update)
        group.delete("/v1/workspaces/:ws/event-subscriptions/:subscription", use: delete)
    }

    @Sendable
    func list(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let subscriptions = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
            let rows = try await conn.query(
                """
                SELECT id, workspace_id, url, event_kinds, enabled,
                       delivery_failure_count, disabled_at, disabled_reason,
                       created_by, updated_by, created_at, updated_at
                  FROM event_subscription
                 WHERE workspace_id = \(workspaceID)
                 ORDER BY created_at DESC, id DESC
                """,
                logger: db.logger
            ).collect()
            return try rows.map(Self.decodeSubscription)
        }
        return try EventSubscriptionsResponse(eventSubscriptions: subscriptions)
            .response(from: request, context: context)
    }

    @Sendable
    func create(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let body = try await request.decode(as: CreateEventSubscriptionRequest.self, context: context)
        // Authorize before any caller-controlled DNS work. The write transaction
        // rechecks under lock so a concurrent role change still fails closed.
        try await requireAdmin(principal: principal, workspaceID: workspaceID)
        let url = try await validatedURL(body.url)
        let eventKinds = try Self.validatedKinds(body.eventKinds)
        let enabled = body.enabled ?? true
        let secretRef = WebhookCrypto.randomReference()
        let subscription = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                INSERT INTO event_subscription
                  (workspace_id, url, secret_ref, event_kinds, enabled,
                   disabled_at, disabled_reason, created_by, updated_by)
                VALUES
                  (\(workspaceID), \(url.absoluteString), \(secretRef), \(eventKinds), \(enabled),
                   \(enabled ? nil : Date())::timestamptz,
                   \(enabled ? nil : "disabled_by_admin")::text,
                   \(principal.memberID), \(principal.memberID))
                RETURNING id, workspace_id, url, event_kinds, enabled,
                          delivery_failure_count, disabled_at, disabled_reason,
                          created_by, updated_by, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.internalServerError, message: "event subscription create failed")
            }
            let value = try Self.decodeSubscription(row)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorID: principal.memberID, subscriptionID: UUID(uuidString: value.id)!,
                action: "event_subscription.created", eventKinds: eventKinds, enabled: enabled
            )
            return value
        }
        let secret = WebhookCrypto.outboundSecret(
            masterKey: signingMasterKey, secretRef: secretRef
        )
        var response = try CreatedEventSubscriptionResponse(
            eventSubscription: subscription, secret: secret
        ).response(from: request, context: context)
        response.status = .created
        return response
    }

    @Sendable
    func update(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let subscriptionID = try Self.subscriptionID(context)
        let body = try await request.decode(as: UpdateEventSubscriptionRequest.self, context: context)
        guard body.url != nil || body.eventKinds != nil || body.enabled != nil else {
            throw HTTPError(.badRequest, message: "event subscription update is empty")
        }
        try await requireAdmin(principal: principal, workspaceID: workspaceID)
        let url = try await body.url.mapAsync(validatedURL)
        let eventKinds = try body.eventKinds.map(Self.validatedKinds)
        let subscription = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                UPDATE event_subscription
                   SET url = COALESCE(\(url?.absoluteString)::text, url),
                       event_kinds = COALESCE(\(eventKinds)::text[], event_kinds),
                       enabled = COALESCE(\(body.enabled)::boolean, enabled),
                       delivery_failure_count = CASE
                         WHEN \(body.enabled) IS TRUE THEN 0
                         ELSE delivery_failure_count
                       END,
                       disabled_at = CASE
                         WHEN \(body.enabled) IS TRUE THEN NULL
                         WHEN \(body.enabled) IS FALSE THEN COALESCE(disabled_at, clock_timestamp())
                         ELSE disabled_at
                       END,
                       disabled_reason = CASE
                         WHEN \(body.enabled) IS TRUE THEN NULL
                         WHEN \(body.enabled) IS FALSE THEN 'disabled_by_admin'
                         ELSE disabled_reason
                       END,
                       updated_by = \(principal.memberID),
                       updated_at = clock_timestamp()
                 WHERE workspace_id = \(workspaceID) AND id = \(subscriptionID)
                RETURNING id, workspace_id, url, event_kinds, enabled,
                          delivery_failure_count, disabled_at, disabled_reason,
                          created_by, updated_by, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "event subscription not found")
            }
            let value = try Self.decodeSubscription(row)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorID: principal.memberID, subscriptionID: subscriptionID,
                action: "event_subscription.updated", eventKinds: value.eventKinds,
                enabled: value.enabled
            )
            return value
        }
        return try EventSubscriptionResponse(eventSubscription: subscription)
            .response(from: request, context: context)
    }

    @Sendable
    func delete(_ request: Request, context: AppRequestContext) async throws -> Response {
        let principal = try Self.requireHuman(context)
        let workspaceID = try InviteRoutes.workspaceID(context, principal: principal)
        let subscriptionID = try Self.subscriptionID(context)
        let subscription = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal, forUpdate: true
            )
            let rows = try await conn.query(
                """
                DELETE FROM event_subscription
                 WHERE workspace_id = \(workspaceID) AND id = \(subscriptionID)
                RETURNING id, workspace_id, url, event_kinds, enabled,
                          delivery_failure_count, disabled_at, disabled_reason,
                          created_by, updated_by, created_at, updated_at
                """,
                logger: db.logger
            ).collect()
            guard let row = rows.first else {
                throw HTTPError(.notFound, message: "event subscription not found")
            }
            let value = try Self.decodeSubscription(row)
            try await Self.insertAudit(
                conn: conn, logger: db.logger, workspaceID: workspaceID,
                actorID: principal.memberID, subscriptionID: subscriptionID,
                action: "event_subscription.deleted", eventKinds: value.eventKinds,
                enabled: value.enabled
            )
            return value
        }
        return try EventSubscriptionResponse(eventSubscription: subscription)
            .response(from: request, context: context)
    }

    private func validatedURL(_ raw: String) async throws -> URL {
        do { return try await urlValidator.validate(raw) }
        catch let error as OutboundURLPolicyError {
            let message: String = switch error {
            case .invalidURL: "webhook URL must be an absolute HTTP(S) URL without credentials or fragment"
            case .insecureHTTP: "webhook URL must use HTTPS"
            case .privateAddress: "webhook URL resolves to a private or reserved address"
            case .resolutionFailed: "webhook URL host could not be resolved"
            }
            throw HTTPError(.badRequest, message: message)
        } catch {
            throw HTTPError(.badRequest, message: "webhook URL validation failed")
        }
    }

    private func requireAdmin(principal: AuthPrincipal, workspaceID: UUID) async throws {
        _ = try await db.withTenantTransaction(workspaceID: workspaceID) { conn in
            try await WorkspaceAuthorization.requireAdmin(
                conn: conn, logger: db.logger, principal: principal
            )
        }
    }

    private static func validatedKinds(_ raw: [String]) throws -> [String] {
        let kinds = Array(Set(raw)).sorted()
        let allowed = Set(EventSubscriptionKind.allCases.map(\.rawValue))
        guard !kinds.isEmpty, kinds.count <= allowed.count,
              kinds.allSatisfy(allowed.contains) else {
            throw HTTPError(
                .badRequest,
                message: "eventKinds must contain mention, approval_request, or work.status_changed"
            )
        }
        return kinds
    }

    private static func subscriptionID(_ context: AppRequestContext) throws -> UUID {
        guard let id = UUID(uuidString: try context.parameters.require("subscription")) else {
            throw HTTPError(.badRequest, message: "invalid event subscription id")
        }
        return id
    }

    private static func requireHuman(_ context: AppRequestContext) throws -> AuthPrincipal {
        let principal = try context.requirePrincipal()
        guard principal.kind == .human else {
            throw HTTPError(.forbidden, message: "event subscriptions require a human admin")
        }
        return principal
    }

    private static func decodeSubscription(_ row: PostgresRow) throws -> EventSubscriptionDTO {
        let decoded = try row.decode((
            UUID, UUID, String, [String], Bool, Int, Date?, String?,
            UUID, UUID, Date, Date
        ).self)
        return EventSubscriptionDTO(
            id: decoded.0.uuidString.lowercased(),
            workspaceId: decoded.1.uuidString.lowercased(),
            url: decoded.2,
            eventKinds: decoded.3,
            enabled: decoded.4,
            deliveryFailureCount: decoded.5,
            disabledAtMs: decoded.6.map { Int64($0.timeIntervalSince1970 * 1_000) },
            disabledReason: decoded.7,
            createdBy: decoded.8.uuidString.lowercased(),
            updatedBy: decoded.9.uuidString.lowercased(),
            createdAtMs: Int64(decoded.10.timeIntervalSince1970 * 1_000),
            updatedAtMs: Int64(decoded.11.timeIntervalSince1970 * 1_000)
        )
    }

    private static func insertAudit(
        conn: PostgresConnection,
        logger: Logger,
        workspaceID: UUID,
        actorID: UUID,
        subscriptionID: UUID,
        action: String,
        eventKinds: [String],
        enabled: Bool
    ) async throws {
        _ = try await conn.query(
            """
            INSERT INTO audit_log
              (workspace_id, actor_member_id, action, target_type, target_id, detail)
            VALUES
              (\(workspaceID), \(actorID), \(action), 'event_subscription',
               \(subscriptionID),
               jsonb_build_object(
                 'schema', 'momo.event_subscription.audit.v1',
                 'event_kinds', to_jsonb(\(eventKinds)::text[]),
                 'enabled', \(enabled)
               ))
            """,
            logger: logger
        )
    }
}

private extension Optional {
    func mapAsync<T>(_ transform: (Wrapped) async throws -> T) async rethrows -> T? {
        guard let value = self else { return nil }
        return try await transform(value)
    }
}
