import AsyncHTTPClient
import CloudProviderKit
import Crypto
import Foundation
import NIOCore
import NIOFoundationCompat
import PostgresNIO

extension NotifierService {
    private struct CloudIntent: Sendable {
        let id: UUID
        let workspaceID: UUID
        let hostID: UUID?
        let sandboxID: String?
        let state: String
        let operationID: UUID?
        let displayName: String?
        let providerID: String

        var ref: CloudInstanceRef? {
            guard let sandboxID else { return nil }
            return CloudInstanceRef(providerID: providerID, instanceID: sandboxID)
        }
    }

    /// ADR-0140 D4 convergence decision for one provider round trip.
    enum CloudLifecycleOutcome: Sendable, Equatable {
        case accepted
        case providerMissing
    }

    /// Converges provider calls which intentionally live outside PostgreSQL.
    /// Claims are leased by timestamp and every provider request carries the
    /// durable operation/provision UUID as its idempotency key.
    func reconcileCloudLifecycle() async {
        guard let readyConfig = try? config.cloudProvider.requireReady() else { return }
        do {
            let candidateRows = try await pg.query(
                """
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
                 LIMIT \(config.claimBatchSize)
                """,
                logger: logger
            ).collect()
            let candidateIDs = try candidateRows.map { try $0.decode(UUID.self) }
            var intents: [CloudIntent] = []
            for candidateID in candidateIDs {
                do {
                    let intent: CloudIntent? = try await pg.withTransaction(
                        logger: logger
                    ) { conn in
                        try await T3LifecycleLock.acquirePrelude(
                            conn: conn,
                            logger: logger,
                            workspaceID: nil,
                            cloudHostID: candidateID
                        )
                        let rows = try await conn.query(
                            """
                            UPDATE work_cloud_host
                               SET lifecycle_operation_started_at = CASE
                                     WHEN state = 'provisioning'
                                       THEN lifecycle_operation_started_at
                                     ELSE clock_timestamp()
                                   END,
                                   updated_at = clock_timestamp()
                             WHERE id = \(candidateID)
                               AND (
                                 (
                                   state = 'provisioning'
                                   AND provider_sandbox_id IS NULL
                                   AND updated_at
                                         < clock_timestamp() - interval '5 seconds'
                                 ) OR (
                                   state IN (
                                     'pausing', 'resuming', 'destroy_pending'
                                   )
                                   AND lifecycle_operation_started_at
                                         < clock_timestamp() - interval '5 seconds'
                                 )
                               )
                            RETURNING id, workspace_id, host_id,
                                      provider_sandbox_id, state,
                                      lifecycle_operation_id,
                                      requested_display_name, provider
                            """,
                            logger: logger
                        ).collect()
                        guard let row = rows.first else { return nil }
                        let value = try row.decode(
                            (UUID, UUID, UUID?, String?, String, UUID?, String?, String)
                                .self
                        )
                        return CloudIntent(
                            id: value.0, workspaceID: value.1, hostID: value.2,
                            sandboxID: value.3, state: value.4,
                            operationID: value.5, displayName: value.6,
                            providerID: value.7
                        )
                    }
                    if let intent { intents.append(intent) }
                } catch {
                    logger.warning("cloud lifecycle intent claim failed", metadata: [
                        "provisionID": .string(candidateID.uuidString.lowercased()),
                        "error": .string(String(describing: error)),
                    ])
                }
            }
            for intent in intents {
                do {
                    try await reconcile(intent: intent, readyConfig: readyConfig)
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

    private func reconcile(
        intent: CloudIntent,
        readyConfig: ReadyCloudProviderSettings
    ) async throws {
        let adapter = try readyConfig.adapter(
            for: intent.providerID, httpClient: httpClient
        )
        if intent.state == "provisioning" {
            try await reconcileProvision(
                intent: intent, readyConfig: readyConfig, adapter: adapter
            )
            return
        }
        guard let ref = intent.ref,
              let operationID = intent.operationID,
              let hostID = intent.hostID
        else { return }
        let idempotencyKey = operationID.uuidString.lowercased()
        var adapterError: CloudProviderError?
        do {
            switch intent.state {
            case "pausing":
                try await adapter.pause(ref: ref, idempotencyKey: idempotencyKey)
            case "resuming":
                try await adapter.resume(ref: ref, idempotencyKey: idempotencyKey)
            case "destroy_pending":
                try await adapter.destroy(ref: ref, idempotencyKey: idempotencyKey)
            default:
                return
            }
        } catch let error as CloudProviderError {
            adapterError = error
        }
        guard let outcome = Self.lifecycleOutcome(
            state: intent.state, error: adapterError
        ) else {
            throw CloudReconcileError.provider(adapterError ?? .invalidResponse)
        }
        let missingSandbox = outcome == .providerMissing
        var probeAnswer = CloudInstancePresence.unknown
        if missingSandbox {
            // ADR-0142 D3.1: before terminally settling a paid session, ask the
            // adapter for the fact. A provider that hides a death (answers
            // `present` for an instance it just refused to resume) contradicts
            // itself, and momo refuses to convert that contradiction into a
            // settlement — the intent stays claimable and named in the log.
            probeAnswer = (try? await adapter.probe(ref: ref)) ?? .unknown
            if probeAnswer == .present {
                logger.warning("provider denied its own missing instance", metadata: [
                    "provisionID": .string(intent.id.uuidString.lowercased()),
                    "provider": .string(intent.providerID),
                    "probe": .string(probeAnswer.rawValue),
                ])
                // Throwing leaves the durable intent claimable rather than
                // downgrading it to a non-terminal path: the contradiction is
                // the operator's to resolve, and retrying is the only move that
                // cannot silently bill or silently strand the session.
                throw CloudReconcileError.dishonestProvider
            }
        }

        try await pg.withTransaction(logger: logger) { conn in
            try await T3LifecycleLock.acquirePrelude(
                conn: conn,
                logger: logger,
                workspaceID: intent.workspaceID,
                cloudHostID: intent.id,
                lockWorkspaceCredit: missingSandbox
            )
            // The provider call intentionally happens outside PostgreSQL. Lock
            // and revalidate the durable intent before touching usage/session
            // state: a terminal sweep may have replaced it while the provider
            // call was in flight.
            let lockedRows = try await conn.query(
                """
                SELECT state, lifecycle_operation_id, host_id
                  FROM work_cloud_host
                 WHERE id = \(intent.id)
                   AND workspace_id = \(intent.workspaceID)
                 FOR UPDATE
                """,
                logger: logger
            ).collect()
            guard let locked = lockedRows.first else {
                throw CloudReconcileError.staleIntent
            }
            let (lockedState, lockedOperationID, lockedHostID) =
                try locked.decode((String, UUID?, UUID?).self)
            guard lockedState == intent.state,
                  lockedOperationID == operationID,
                  lockedHostID == hostID
            else {
                throw CloudReconcileError.staleIntent
            }

            if missingSandbox {
                let usageRows = try await conn.query(
                    """
                    SELECT session_id
                      FROM work_host_usage
                     WHERE workspace_id = \(intent.workspaceID)
                       AND host_id = \(hostID)
                       AND settled_at IS NULL
                     FOR UPDATE
                    """,
                    logger: logger
                ).collect()
                var terminalSession: (id: UUID, memberID: UUID)?
                if let usageRow = usageRows.first {
                    let sessionID = try usageRow.decode(UUID.self)
                    let sessionRows = try await conn.query(
                        """
                        SELECT member_id
                          FROM work_session
                         WHERE workspace_id = \(intent.workspaceID)
                           AND id = \(sessionID)
                         FOR UPDATE
                        """,
                        logger: logger
                    ).collect()
                    guard let memberID = try sessionRows.first?.decode(UUID.self) else {
                        throw CloudReconcileError.staleIntent
                    }
                    terminalSession = (sessionID, memberID)
                    _ = try await conn.query(
                        """
                        SELECT t3_terminate(
                          \(intent.workspaceID), \(sessionID), 'provider_missing'
                        )
                        """,
                        logger: logger
                    ).collect()
                } else {
                    _ = try await conn.query(
                        """
                        UPDATE work_cloud_host
                           SET state = 'destroy_pending',
                               lifecycle_operation_kind = 'destroy',
                               lifecycle_operation_version =
                                 lifecycle_operation_version + 1,
                               updated_at = clock_timestamp()
                         WHERE id = \(intent.id)
                           AND workspace_id = \(intent.workspaceID)
                           AND lifecycle_operation_id = \(operationID)
                           AND state = \(intent.state)
                        """,
                        logger: logger
                    )
                }
                let terminalRows = try await conn.query(
                    """
                    UPDATE work_cloud_host
                       SET state = 'destroyed', updated_at = clock_timestamp()
                     WHERE id = \(intent.id)
                       AND workspace_id = \(intent.workspaceID)
                       AND lifecycle_operation_id = \(operationID)
                       AND state = 'destroy_pending'
                    RETURNING id
                    """,
                    logger: logger
                ).collect()
                guard terminalRows.count == 1 else {
                    throw CloudReconcileError.staleIntent
                }
                _ = try await conn.query(
                    """
                    UPDATE work_host
                       SET revoked_at = COALESCE(revoked_at, clock_timestamp()),
                           last_seen_at = clock_timestamp() - interval '100 years'
                     WHERE workspace_id = \(intent.workspaceID)
                       AND id = \(hostID)
                    """,
                    logger: logger
                )
                if let terminalSession {
                    _ = try await conn.query(
                        """
                        INSERT INTO audit_log
                          (workspace_id, actor_member_id, subject_member_id,
                           action, target_type, target_id, via_token_id, detail)
                        VALUES
                          (\(intent.workspaceID), \(terminalSession.memberID),
                           \(terminalSession.memberID),
                           'work.cloud.resume_failed', 'work_host', \(hostID), NULL,
                           jsonb_build_object(
                             'schema', 'momo.work_cloud.resume_failed.v1',
                             'host_id', lower(\(hostID)::text),
                             'session_id', lower(\(terminalSession.id)::text),
                             'provider', \(intent.providerID),
                             'reason', 'sandbox_missing',
                             'provider_probe', \(probeAnswer.rawValue),
                             'orphan_transition', 'host_offline_sweep',
                             'source', 'lifecycle_reconciler'
                           ))
                        """,
                        logger: logger
                    )
                }
                return
            }

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
            let updatedRows = try await conn.query(
                """
                UPDATE work_cloud_host
                   SET state = \(intent.state == "pausing" ? "paused" :
                                 intent.state == "resuming" ? "running" : "destroyed"),
                       updated_at = clock_timestamp()
                 WHERE id = \(intent.id)
                   AND lifecycle_operation_id = \(operationID)
                   AND state = \(intent.state)
                RETURNING id
                """,
                logger: logger
            ).collect()
            guard updatedRows.count == 1 else {
                throw CloudReconcileError.staleIntent
            }
            if intent.state == "destroy_pending" {
                _ = try await conn.query(
                    """
                    UPDATE work_host
                       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
                     WHERE workspace_id = \(intent.workspaceID)
                       AND id = \(hostID)
                    """,
                    logger: logger
                )
            }
        }
    }

    private func reconcileProvision(
        intent: CloudIntent,
        readyConfig: ReadyCloudProviderSettings,
        adapter: any CloudProviderAdapter
    ) async throws {
        // A degenerate adapter never had a create to converge: a BYOC row's
        // instance handle exists from enrollment onward.
        guard adapter.capabilities.supports(.create),
              let secret = readyConfig.bootstrapSecret(for: intent.providerID),
              let displayName = intent.displayName
        else { return }
        let token = bootstrapToken(provisionID: intent.id, secret: secret)
        let instance = try await adapter.create(
            spec: CloudInstanceSpec(
                provisionID: intent.id,
                workspaceID: intent.workspaceID,
                displayName: displayName,
                registrationToken: token,
                serverURL: readyConfig.publicServerURL
            ),
            idempotencyKey: intent.id.uuidString.lowercased()
        )
        let sandboxID = instance.instanceID
        let updated = try await pg.withTransaction(logger: logger) { conn in
            try await T3LifecycleLock.acquirePrelude(
                conn: conn,
                logger: logger,
                workspaceID: intent.workspaceID,
                cloudHostID: intent.id
            )
            return try await conn.query(
                """
                UPDATE work_cloud_host
                   SET provider_sandbox_id = \(sandboxID),
                       state = CASE
                         WHEN host_id IS NULL THEN 'provisioning'
                         ELSE 'ready'
                       END,
                       updated_at = clock_timestamp()
                 WHERE id = \(intent.id)
                   AND state = 'provisioning'
                   AND provider_sandbox_id IS NULL
                RETURNING id
                """,
                logger: logger
            ).collect()
        }
        if updated.first == nil {
            try await adapter.destroy(
                ref: instance,
                idempotencyKey: "cleanup-\(intent.id.uuidString.lowercased())"
            )
        }
    }

    private func bootstrapToken(provisionID: UUID, secret: String) -> String {
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

    /// ADR-0140 D4 in adapter terms. `nil` means "not converged — retry".
    ///
    /// Only a resume whose adapter states the instance is gone is terminal.
    /// `destroy` already treats absence as success inside the adapter, and a
    /// pause that failed is simply retried; neither may settle a paid session.
    static func lifecycleOutcome(
        state: String,
        error: CloudProviderError?
    ) -> CloudLifecycleOutcome? {
        switch state {
        case "pausing", "destroy_pending":
            return error == nil ? .accepted : nil
        case "resuming":
            if error == nil { return .accepted }
            return error == .instanceMissing ? .providerMissing : nil
        default:
            return nil
        }
    }
}

private enum CloudReconcileError: Error {
    case provider(CloudProviderError)
    case dishonestProvider
    case invalidResponse
    case staleIntent
}
