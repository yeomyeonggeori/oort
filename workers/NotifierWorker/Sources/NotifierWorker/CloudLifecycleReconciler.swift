import AsyncHTTPClient
import Crypto
import Foundation
import NIOCore
import NIOFoundationCompat
import PostgresNIO

extension NotifierService {
    private enum ProviderMethod { case post, delete }
    private struct CloudIntent: Sendable {
        let id: UUID
        let workspaceID: UUID
        let hostID: UUID?
        let sandboxID: String?
        let state: String
        let operationID: UUID?
        let displayName: String?
    }

    /// Converges provider calls which intentionally live outside PostgreSQL.
    /// Claims are leased by timestamp and every provider request carries the
    /// durable operation/provision UUID as its idempotency key.
    func reconcileCloudLifecycle() async {
        guard let apiKey = config.e2bAPIKey, !apiKey.isEmpty else { return }
        do {
            let intents = try await pg.withTransaction(logger: logger) { conn in
                let rows = try await conn.query(
                    """
                    WITH claimed AS (
                      SELECT id
                        FROM work_cloud_host
                       WHERE (
                         state = 'provisioning' AND provider_sandbox_id IS NULL
                         AND updated_at < clock_timestamp() - interval '5 seconds'
                       ) OR (
                         state IN ('pausing', 'resuming', 'destroy_pending')
                         AND lifecycle_operation_started_at
                               < clock_timestamp() - interval '5 seconds'
                       )
                       ORDER BY updated_at, id
                       FOR UPDATE SKIP LOCKED
                       LIMIT \(config.claimBatchSize)
                    )
                    UPDATE work_cloud_host ch
                       SET lifecycle_operation_started_at = CASE
                             WHEN ch.state = 'provisioning'
                               THEN ch.lifecycle_operation_started_at
                             ELSE clock_timestamp()
                           END,
                           updated_at = clock_timestamp()
                      FROM claimed
                     WHERE ch.id = claimed.id
                    RETURNING ch.id, ch.workspace_id, ch.host_id,
                              ch.provider_sandbox_id, ch.state,
                              ch.lifecycle_operation_id,
                              ch.requested_display_name
                    """,
                    logger: logger
                ).collect()
                return try rows.map {
                    let value = try $0.decode(
                        (UUID, UUID, UUID?, String?, String, UUID?, String?).self
                    )
                    return CloudIntent(
                        id: value.0, workspaceID: value.1, hostID: value.2,
                        sandboxID: value.3, state: value.4,
                        operationID: value.5, displayName: value.6
                    )
                }
            }
            for intent in intents {
                do {
                    try await reconcile(intent: intent, apiKey: apiKey)
                } catch {
                    logger.warning("cloud lifecycle reconciliation will retry", metadata: [
                        "provisionID": .string(intent.id.uuidString.lowercased()),
                        "state": .string(intent.state),
                        "error": .string(String(describing: error)),
                    ])
                }
            }
        } catch {
            logger.warning("cloud lifecycle intent claim failed", metadata: [
                "error": .string(String(describing: error)),
            ])
        }
    }

    private func reconcile(intent: CloudIntent, apiKey: String) async throws {
        if intent.state == "provisioning" {
            try await reconcileProvision(intent: intent, apiKey: apiKey)
            return
        }
        guard let sandboxID = intent.sandboxID,
              let operationID = intent.operationID,
              let hostID = intent.hostID
        else { return }
        let path: String
        let method: ProviderMethod
        let body: Data?
        switch intent.state {
        case "pausing":
            path = "/sandboxes/\(try safeID(sandboxID))/pause"
            method = .post
            body = nil
        case "resuming":
            path = "/sandboxes/\(try safeID(sandboxID))/connect"
            method = .post
            body = try JSONSerialization.data(
                withJSONObject: ["timeout": config.e2bSandboxTimeoutSeconds]
            )
        case "destroy_pending":
            path = "/sandboxes/\(try safeID(sandboxID))"
            method = .delete
            body = nil
        default:
            return
        }
        let status = try await providerRequest(
            method: method,
            path: path,
            body: body,
            idempotencyKey: operationID.uuidString.lowercased(),
            apiKey: apiKey
        ).status.code
        let accepted = switch intent.state {
        case "pausing": status == 204
        case "resuming": status == 200 || status == 201
        case "destroy_pending": status == 204 || status == 404 || status == 410
        default: false
        }
        guard accepted else { throw CloudReconcileError.upstream(Int(status)) }

        try await pg.withTransaction(logger: logger) { conn in
            if intent.state == "pausing" || intent.state == "resuming" {
                let expectedInterval = intent.state == "pausing" ? "active" : "paused"
                let nextInterval = intent.state == "pausing" ? "paused" : "active"
                _ = try await conn.query(
                    """
                    WITH usage AS (
                      SELECT id, session_id, workspace_id
                        FROM work_host_usage
                       WHERE workspace_id = \(intent.workspaceID)
                         AND host_id = \(hostID)
                         AND settled_at IS NULL
                       FOR UPDATE
                    ), closed AS (
                      UPDATE work_host_usage_interval i
                         SET ended_at = clock_timestamp()
                        FROM usage u
                       WHERE i.usage_id = u.id
                         AND i.state = \(expectedInterval)
                         AND i.ended_at IS NULL
                      RETURNING i.usage_id
                    ), opened AS (
                      INSERT INTO work_host_usage_interval
                        (usage_id, workspace_id, state)
                      SELECT c.usage_id, \(intent.workspaceID), \(nextInterval)
                        FROM closed c
                      RETURNING usage_id
                    )
                    UPDATE work_session ws
                       SET status = \(intent.state == "pausing" ? "idle" : "running"),
                           idle_at = CASE
                             WHEN \(intent.state == "pausing") THEN clock_timestamp()
                             ELSE NULL
                           END
                      FROM usage u, opened o
                     WHERE ws.id = u.session_id
                       AND o.usage_id = u.id
                    """,
                    logger: logger
                )
            }
            _ = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(intent.state == "pausing" ? "paused" :
                                 intent.state == "resuming" ? "running" : "destroyed"),
                       updated_at = clock_timestamp()
                 WHERE id = \(intent.id)
                   AND lifecycle_operation_id = \(operationID)
                   AND state = \(intent.state)
                """,
                logger: logger
            )
        }
    }

    private func reconcileProvision(intent: CloudIntent, apiKey: String) async throws {
        guard let templateID = config.e2bTemplateID,
              let publicURL = config.momoPublicBaseURL,
              let displayName = intent.displayName
        else { return }
        let token = bootstrapToken(provisionID: intent.id, apiKey: apiKey)
        let object: [String: Any] = [
            "templateID": templateID,
            "timeout": config.e2bSandboxTimeoutSeconds,
            "autoPause": false,
            "secure": true,
            "metadata": [
                "momo_provision_id": intent.id.uuidString.lowercased(),
                "momo_workspace_id": intent.workspaceID.uuidString.lowercased(),
            ],
            "envVars": [
                "MOMO_WORKD_SERVER_URL": publicURL,
                "MOMO_WORKD_WORKSPACE_ID": intent.workspaceID.uuidString.lowercased(),
                "MOMO_WORKD_SCOPE": "workspace",
                "MOMO_WORKD_HOST_TYPE": "cloud",
                "MOMO_WORKD_DISPLAY_NAME": displayName,
                "MOMO_WORKD_REGISTRATION_TOKEN": token,
            ],
        ]
        let response = try await providerRequest(
            method: .post,
            path: "/sandboxes",
            body: try JSONSerialization.data(withJSONObject: object),
            idempotencyKey: intent.id.uuidString.lowercased(),
            apiKey: apiKey
        )
        guard response.status.code == 201 else {
            throw CloudReconcileError.upstream(Int(response.status.code))
        }
        var buffer = try await response.body.collect(upTo: 64 * 1024)
        let data = buffer.readData(length: buffer.readableBytes) ?? Data()
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sandboxID = json["sandboxID"] as? String,
              !sandboxID.isEmpty
        else { throw CloudReconcileError.invalidResponse }
        let updated = try await pg.query(
            """
            UPDATE work_cloud_host
               SET provider_sandbox_id = \(sandboxID),
                   state = CASE WHEN host_id IS NULL THEN 'provisioning' ELSE 'ready' END,
                   updated_at = clock_timestamp()
             WHERE id = \(intent.id)
               AND state = 'provisioning'
               AND provider_sandbox_id IS NULL
            RETURNING id
            """,
            logger: logger
        ).collect()
        if updated.first == nil {
            _ = try await providerRequest(
                method: .delete,
                path: "/sandboxes/\(try safeID(sandboxID))",
                body: nil,
                idempotencyKey: "cleanup-\(intent.id.uuidString.lowercased())",
                apiKey: apiKey
            )
        }
    }

    private func providerRequest(
        method: ProviderMethod,
        path: String,
        body: Data?,
        idempotencyKey: String,
        apiKey: String
    ) async throws -> HTTPClientResponse {
        var request = HTTPClientRequest(url: config.e2bAPIBaseURL + path)
        switch method {
        case .post: request.method = .POST
        case .delete: request.method = .DELETE
        }
        request.headers.add(name: "X-API-Key", value: apiKey)
        request.headers.add(name: "Accept", value: "application/json")
        request.headers.add(name: "Idempotency-Key", value: idempotencyKey)
        if let body {
            request.headers.add(name: "Content-Type", value: "application/json")
            request.body = .bytes(ByteBuffer(data: body))
        }
        return try await httpClient.execute(request, timeout: .seconds(30))
    }

    private func bootstrapToken(provisionID: UUID, apiKey: String) -> String {
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

    private func safeID(_ value: String) throws -> String {
        guard value.wholeMatch(of: /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) != nil else {
            throw CloudReconcileError.invalidResponse
        }
        return value
    }
}

private enum CloudReconcileError: Error {
    case upstream(Int)
    case invalidResponse
}
